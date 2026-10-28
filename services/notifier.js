import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LEVEL_WEIGHT = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

function isoTimestamp() {
  return new Date().toISOString();
}

/** Normaliza un teléfono a un id de chat de WhatsApp. */
export function toChatId(value) {
  const clean = String(value ?? "").trim();
  if (!clean) return "";
  if (clean.includes("@")) return clean;
  const digits = clean.replace(/\D/g, "");
  return digits ? `${digits}@c.us` : "";
}

/**
 * Registra eventos y envía avisos por los canales configurados.
 *
 * Canales disponibles (todos opcionales):
 *  - consola y archivo de log (LOG_FILE)
 *  - webhook genérico (ALERT_WEBHOOK_URL)
 *  - Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *  - WhatsApp al número/chat de administración (ADMIN_NOTIFY_NUMBER).
 *    Si WhatsApp está caído, los avisos se encolan y se envían al reconectar.
 */
export class Notifier {
  constructor(options = {}) {
    this.host = options.host ?? os.hostname();
    this.service = options.service ?? null;
    this.minLevel = options.minLevel ?? "info";
    this.logFile = options.logFile ?? "";
    this.webhookUrl = options.webhookUrl ?? "";
    this.webhookToken = options.webhookToken ?? "";
    this.telegramToken = options.telegramToken ?? "";
    this.telegramChatId = options.telegramChatId ?? "";
    this.adminChatId = toChatId(options.adminNumber);
    this.throttleMs = Number(options.throttleMs ?? 60_000);
    this.httpTimeoutMs = Number(options.httpTimeoutMs ?? 8_000);
    this.silent = Boolean(options.silent);

    this.lastAlertAt = new Map();
    this.pendingWhatsApp = [];
    this.maxPending = 20;
    this.fileReady = false;
  }

  attachService(service) {
    this.service = service;
  }

  log(message, level = "info") {
    const normalized = LEVEL_WEIGHT[level] === undefined ? "info" : level;
    if (LEVEL_WEIGHT[normalized] < LEVEL_WEIGHT[this.minLevel]) return;

    const line = `[${isoTimestamp()}] [${normalized.toUpperCase()}] ${message}`;
    if (!this.silent) {
      if (normalized === "error" || normalized === "warn") {
        console.error(line);
      } else {
        console.log(line);
      }
    }

    if (this.logFile) void this.#writeLogFile(line);
  }

  /**
   * Avisa por todos los canales. Las alertas repetidas con la misma `key`
   * se silencian durante `throttleMs` para no inundar al operador.
   */
  async alert(message, level = "error", key = "general") {
    this.log(message, level);

    const now = Date.now();
    const last = this.lastAlertAt.get(key) ?? 0;
    if (now - last < this.throttleMs) {
      this.log(`Aviso "${key}" silenciado por throttle`, "debug");
      return;
    }
    this.lastAlertAt.set(key, now);

    const text = `[${this.host}] [wa-micredito] ${message}`;

    await Promise.allSettled([
      this.#sendWebhook(text, level, key),
      this.#sendTelegram(text),
      this.#sendWhatsApp(text),
    ]);
  }

  /** Reenvía los avisos que quedaron pendientes mientras WhatsApp estaba caído. */
  async flushWhatsApp() {
    if (!this.service?.isReady || this.pendingWhatsApp.length === 0) return;

    const pending = this.pendingWhatsApp.splice(0);
    for (const text of pending) {
      try {
        await this.service.sendMessage(this.adminChatId, text);
      } catch (error) {
        this.log(`No se pudo enviar el aviso pendiente por WhatsApp: ${error.message}`, "warn");
        this.pendingWhatsApp.unshift(text);
        return;
      }
    }
    this.log(`Se enviaron ${pending.length} aviso(s) pendiente(s) por WhatsApp`, "info");
  }

  async #writeLogFile(line) {
    try {
      if (!this.fileReady) {
        await mkdir(path.dirname(this.logFile), { recursive: true });
        this.fileReady = true;
      }
      await appendFile(this.logFile, `${line}\n`, "utf8");
    } catch (error) {
      console.error(`No se pudo escribir el log en ${this.logFile}: ${error.message}`);
    }
  }

  async #sendWebhook(text, level, key) {
    if (!this.webhookUrl) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.webhookToken
            ? { Authorization: `Bearer ${this.webhookToken}` }
            : {}),
        },
        body: JSON.stringify({
          service: "wa-micredito",
          host: this.host,
          level,
          key,
          text,
          timestamp: isoTimestamp(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.log(`No se pudo enviar el aviso por webhook: ${error.message}`, "warn");
    } finally {
      clearTimeout(timer);
    }
  }

  async #sendTelegram(text) {
    if (!this.telegramToken || !this.telegramChatId) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.log(`No se pudo enviar el aviso por Telegram: ${error.message}`, "warn");
    } finally {
      clearTimeout(timer);
    }
  }

  async #sendWhatsApp(text) {
    if (!this.adminChatId) return;

    if (!this.service?.isReady) {
      this.#queueWhatsApp(text);
      return;
    }

    try {
      await this.service.sendMessage(this.adminChatId, text);
    } catch (error) {
      this.log(`No se pudo enviar el aviso por WhatsApp: ${error.message}`, "warn");
      this.#queueWhatsApp(text);
    }
  }

  #queueWhatsApp(text) {
    if (this.pendingWhatsApp.length >= this.maxPending) {
      this.pendingWhatsApp.shift();
    }
    this.pendingWhatsApp.push(text);
    this.log("Aviso encolado hasta que WhatsApp vuelva a conectarse", "debug");
  }
}

/** Crea el notificador a partir de las variables de entorno. */
export function createNotifier(options = {}) {
  return new Notifier({
    service: options.service,
    minLevel: process.env.LOG_LEVEL || "info",
    logFile: process.env.LOG_FILE || "",
    webhookUrl: process.env.ALERT_WEBHOOK_URL || "",
    webhookToken: process.env.ALERT_WEBHOOK_TOKEN || "",
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    adminNumber: process.env.ADMIN_NOTIFY_NUMBER || "",
    throttleMs: process.env.ALERT_THROTTLE_MS || 60_000,
  });
}
