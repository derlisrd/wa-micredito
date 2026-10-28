import { EventEmitter } from "node:events";
import { readlink, rm } from "node:fs/promises";
import path from "node:path";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

export const WA_STATE = Object.freeze({
  STOPPED: "stopped",
  STARTING: "starting",
  QR: "qr",
  READY: "ready",
  RECONNECTING: "reconnecting",
});

export class WhatsAppNotReadyError extends Error {
  constructor(message, state) {
    super(message);
    this.name = "WhatsAppNotReadyError";
    this.state = state;
  }
}

/**
 * Rechaza si la promesa no termina en `ms`. Evita que una operación del
 * navegador (que puede colgarse) bloquee el watchdog o el apagado.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms} ms en ${label}`));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatDelay(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Ciclo de vida del cliente de WhatsApp.
 *
 * Responsabilidades:
 *  - Crear/destruir el cliente y su navegador Chromium.
 *  - Reconectar con backoff exponencial ante caídas o desconexiones.
 *  - Vigilar la salud de la conexión y reiniciar el cliente si se cuelga.
 *  - Emitir eventos (`log`, `alert`, `ready`, `reconnecting`, `qr`,
 *    `exhausted`) para que quien lo use avise al operador.
 */
export class WhatsAppService extends EventEmitter {
  constructor(options = {}) {
    super();

    this.sessionPath = options.sessionPath ?? "./session";
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 30_000;
    this.minReconnectDelayMs = options.minReconnectDelayMs ?? 5_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
    this.initTimeoutMs = options.initTimeoutMs ?? 120_000;
    this.stateTimeoutMs = options.stateTimeoutMs ?? 15_000;
    this.destroyTimeoutMs = options.destroyTimeoutMs ?? 20_000;
    this.maxHealthFailures = options.maxHealthFailures ?? 3;
    this.qrMaxAgeMs = options.qrMaxAgeMs ?? 10 * 60_000;
    this.createClient =
      options.clientFactory ?? (() => new Client(this.#clientOptions()));

    this.client = null;
    this.state = WA_STATE.STOPPED;
    this.stateSince = null;
    this.startedAt = null;
    this.readyAt = null;
    this.lastHealthCheck = null;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;

    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.connecting = false;
    this.restartInProgress = false;
    this.stopping = false;
    this.readyWaiters = new Set();
  }

  get isReady() {
    return this.state === WA_STATE.READY && Boolean(this.client?.info);
  }

  async start() {
    if (this.startedAt) return;
    this.startedAt = Date.now();
    this.stopping = false;
    this.#startWatchdog();
    await this.#connect();
  }

  /** Fuerza un reinicio del cliente (útil para un endpoint manual). */
  async restart(reason = "manual") {
    return this.#restart(reason);
  }

  /** Espera a que la conexión esté lista, con un máximo de `timeoutMs`. */
  waitUntilReady(timeoutMs = 10_000) {
    if (this.isReady) return Promise.resolve(true);

    return new Promise((resolve) => {
      const waiter = (value) => {
        clearTimeout(timer);
        this.readyWaiters.delete(waiter);
        resolve(value);
      };

      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        resolve(this.isReady);
      }, timeoutMs);

      this.readyWaiters.add(waiter);
    });
  }

  async sendMessage(chatId, text) {
    if (!this.isReady) {
      throw new WhatsAppNotReadyError(
        `WhatsApp no está conectado (estado: ${this.state})`,
        this.state,
      );
    }
    return this.client.sendMessage(chatId, text);
  }

  async getChats() {
    if (!this.isReady) {
      throw new WhatsAppNotReadyError(
        `WhatsApp no está conectado (estado: ${this.state})`,
        this.state,
      );
    }
    return this.client.getChats();
  }

  /**
   * Analiza un error de envío. Si parece un problema de sesión/navegador,
   * dispara un reinicio del cliente y devuelve `true`.
   */
  handleSendError(error) {
    const message = error?.message ?? String(error);
    this.lastError = message;
    this.emit("log", `Error al enviar mensaje: ${message}`, "error");

    const looksLikeBrokenSession =
      /detached Frame|Session closed|Protocol error|Target closed|Navigation failed|Execution context was destroyed|Cannot read properties of null|not connected/i.test(
        message,
      );

    if (looksLikeBrokenSession) {
      this.emit("alert", {
        message: `Fallo al enviar un mensaje; reiniciando WhatsApp (${message})`,
        level: "error",
        key: "send_error",
      });
      void this.#restart("send_error");
      return true;
    }

    return false;
  }

  status() {
    return {
      state: this.state,
      isReady: this.isReady,
      browserConnected: this.#isBrowserConnected(),
      stateSince: this.stateSince ? new Date(this.stateSince).toISOString() : null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      readyAt: this.readyAt ? new Date(this.readyAt).toISOString() : null,
      lastHealthCheck: this.lastHealthCheck
        ? new Date(this.lastHealthCheck).toISOString()
        : null,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      uptimeSeconds: this.startedAt
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : 0,
    };
  }

  async stop() {
    this.stopping = true;
    this.#clearReconnectTimer();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.#resolveReadyWaiters(false);
    await this.#destroyClient();
    this.#setState(WA_STATE.STOPPED);
  }

  #createClient() {
    return this.createClient();
  }

  #clientOptions() {
    return {
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
    };
  }

  async #connect() {
    if (this.stopping) return;

    if (this.connecting) {
      // Ya hay una conexión en curso: reintentamos cuando termine.
      this.#scheduleReconnect("connect_in_progress");
      return;
    }

    this.connecting = true;
    this.#clearReconnectTimer();
    this.#setState(
      this.reconnectAttempts > 0 ? WA_STATE.RECONNECTING : WA_STATE.STARTING,
    );

    const client = this.#createClient();
    this.client = client;
    this.#attachHandlers(client);

    try {
      this.emit(
        "log",
        `Inicializando WhatsApp (intento ${this.reconnectAttempts + 1})…`,
        "info",
      );
      await withTimeout(
        client.initialize(),
        this.initTimeoutMs,
        "client.initialize()",
      );
      this.#hookBrowser(client);
      this.emit("log", "WhatsApp inicializado, esperando sesión…", "info");
    } catch (error) {
      const message = error?.message ?? String(error);
      this.lastError = message;
      this.consecutiveFailures += 1;
      this.emit("log", `Falló la inicialización de WhatsApp: ${message}`, "error");

      await this.#destroyClient();

      if (/already running|ProcessSingleton/i.test(message)) {
        await this.#handleProfileLock(message);
      } else {
        this.#scheduleReconnect("initialize_error");
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Chrome guarda un `SingletonLock` en el perfil. Si el proceso anterior
   * murió con SIGKILL (o el VPS se reinició), el lock queda apuntando a un PID
   * inexistente y todos los arranques fallan con "browser is already running".
   * Si el PID dueño sigue vivo, asumimos que hay otra instancia usando la
   * misma sesión y NO tocamos nada: solo avisamos.
   */
  async #handleProfileLock(message) {
    const profileDir = path.resolve(this.sessionPath, "session");
    const lockPath = path.join(profileDir, "SingletonLock");

    let ownerPid = null;
    try {
      const target = await readlink(lockPath);
      ownerPid = Number(String(target).split("-").pop());
    } catch {
      ownerPid = null;
    }

    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      let alive = false;
      try {
        process.kill(ownerPid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === "EPERM";
      }

      if (alive) {
        this.emit("alert", {
          message:
            `No se puede iniciar WhatsApp: otra instancia (pid ${ownerPid}) está usando ` +
            "la misma sesión. Cerrá la otra instancia o usá un SESSION_PATH distinto.",
          level: "error",
          key: "profile_locked",
        });
        this.#scheduleReconnect("profile_locked");
        return;
      }

      this.emit(
        "log",
        `Se encontró un bloqueo de perfil huérfano (pid ${ownerPid}); limpiándolo…`,
        "warn",
      );
    }

    for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await rm(path.join(profileDir, file), { force: true }).catch(() => {});
    }

    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      this.emit("alert", {
        message: `No se pudo iniciar WhatsApp por el perfil bloqueado: ${message}`,
        level: "error",
        key: "profile_lock",
      });
    }

    this.#scheduleReconnect("stale_profile_lock");
  }

  #attachHandlers(client) {
    const isCurrent = () => this.client === client;

    client.on("qr", (qr) => {
      if (!isCurrent()) return;
      this.#setState(WA_STATE.QR);
      // Cada QR nuevo renueva el plazo: si la generación se detiene, el
      // watchdog reinicia el cliente.
      this.stateSince = Date.now();
      this.emit("qr", qr);
    });

    client.on("authenticated", () => {
      if (!isCurrent()) return;
      this.emit("log", "Sesión autenticada, terminando de cargar WhatsApp…", "info");
    });

    client.on("ready", () => {
      if (!isCurrent()) return;
      this.reconnectAttempts = 0;
      this.consecutiveFailures = 0;
      this.readyAt = Date.now();
      this.lastError = null;
      this.#setState(WA_STATE.READY);
      this.#hookBrowser(client);
      this.emit("log", "Cliente de WhatsApp conectado", "info");
      this.emit("ready");
      this.#resolveReadyWaiters(true);
    });

    client.on("auth_failure", (message) => {
      if (!isCurrent()) return;
      this.lastError = `auth_failure: ${message}`;
      this.consecutiveFailures += 1;
      this.emit("log", `Fallo de autenticación de WhatsApp: ${message}`, "error");
      void this.#restart("auth_failure");
    });

    client.on("disconnected", (reason) => {
      if (!isCurrent()) return;
      this.lastError = `disconnected: ${reason}`;
      this.emit("log", `WhatsApp se desconectó: ${reason}`, "error");

      if (String(reason).toUpperCase() === "LOGOUT") {
        this.emit("alert", {
          message:
            "WhatsApp cerró la sesión (LOGOUT). Hay que volver a escanear el QR con el teléfono.",
          level: "error",
          key: "logout",
        });
      }

      void this.#restart("disconnected");
    });

    client.on("change_state", (state) => {
      if (!isCurrent()) return;
      this.emit("log", `Estado interno de WhatsApp: ${state}`, "debug");
    });
  }

  #hookBrowser(client) {
    if (!client || client.__browserHooked) return;
    const browser = client.pupBrowser;
    if (!browser?.on) return;

    client.__browserHooked = true;
    browser.on("disconnected", () => {
      if (this.client !== client || this.stopping || this.restartInProgress) return;
      this.lastError = "browser_disconnected";
      this.emit("log", "El navegador de WhatsApp se cerró inesperadamente", "error");
      void this.#restart("browser_disconnected");
    });
  }

  #clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Programa el próximo intento con backoff exponencial + jitter.
   */
  #scheduleReconnect(reason) {
    if (this.stopping || this.reconnectTimer) return;

    if (
      this.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      this.emit(
        "log",
        `Se agotaron los ${this.maxReconnectAttempts} intentos de reconexión`,
        "error",
      );
      this.emit("exhausted");
      return;
    }

    const attempt = this.reconnectAttempts + 1;
    const base = Math.min(
      this.minReconnectDelayMs * 2 ** (attempt - 1),
      this.maxReconnectDelayMs,
    );
    const delayMs = Math.round(base * (0.8 + Math.random() * 0.4));

    this.reconnectAttempts = attempt;
    this.#setState(WA_STATE.RECONNECTING);

    this.emit(
      "log",
      `Reintentando conectar WhatsApp en ${formatDelay(delayMs)} ` +
        `(intento ${attempt}/${this.maxReconnectAttempts || "∞"}, motivo: ${reason})`,
      "warn",
    );
    this.emit("reconnecting", { attempt, delayMs, reason });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async #restart(reason) {
    if (this.stopping || this.restartInProgress) return;

    this.restartInProgress = true;
    try {
      this.emit("log", `Reiniciando cliente de WhatsApp (motivo: ${reason})…`, "warn");
      this.#setState(WA_STATE.RECONNECTING);
      this.#clearReconnectTimer();
      await this.#destroyClient();
      this.#scheduleReconnect(reason);
    } finally {
      this.restartInProgress = false;
    }
  }

  async #destroyClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;

    let browserPid = null;
    try {
      browserPid = client.pupBrowser?.process?.()?.pid ?? null;
    } catch {
      browserPid = null;
    }

    try {
      await withTimeout(
        Promise.resolve().then(() => client.destroy()),
        this.destroyTimeoutMs,
        "client.destroy()",
      );
    } catch (error) {
      this.emit(
        "log",
        `No se pudo cerrar el navegador limpiamente: ${error.message}`,
        "warn",
      );
      // Evita dejar procesos de Chromium zombie consumiendo memoria.
      if (browserPid) {
        try {
          process.kill(browserPid, "SIGKILL");
          this.emit("log", `Proceso de Chromium ${browserPid} terminado a la fuerza`, "warn");
        } catch {
          // El proceso ya no existía.
        }
      }
    }
  }

  #startWatchdog() {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(() => {
      void this.#checkHealth();
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  async #checkHealth() {
    if (this.stopping || this.connecting || this.restartInProgress) return;

    if (this.state === WA_STATE.READY) {
      await this.#checkReadyHealth();
      return;
    }

    if (this.state === WA_STATE.QR) {
      if (this.stateSince && Date.now() - this.stateSince > this.qrMaxAgeMs) {
        this.emit("log", "El QR venció sin escanear; generando uno nuevo…", "warn");
        await this.#restart("qr_expired");
      }
      return;
    }

    const stuckTooLong =
      (this.state === WA_STATE.STARTING || this.state === WA_STATE.RECONNECTING) &&
      this.client &&
      !this.reconnectTimer &&
      this.stateSince &&
      Date.now() - this.stateSince > this.initTimeoutMs;

    if (stuckTooLong) {
      this.emit("log", "La conexión quedó estancada; forzando reinicio…", "warn");
      await this.#restart("stuck");
    }
  }

  async #checkReadyHealth() {
    if (!this.client || !this.#isBrowserConnected()) {
      this.emit("log", "El navegador de WhatsApp no responde; reiniciando…", "error");
      await this.#restart("browser_down");
      return;
    }

    try {
      const state =
        typeof this.client.getState === "function"
          ? await withTimeout(
              this.client.getState(),
              this.stateTimeoutMs,
              "client.getState()",
            )
          : "CONNECTED";

      this.lastHealthCheck = Date.now();

      if (state !== "CONNECTED") {
        this.consecutiveFailures += 1;
        this.emit("log", `WhatsApp reporta un estado no saludable: ${state}`, "warn");
        await this.#restart(`state_${state}`);
        return;
      }

      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.emit(
        "log",
        `Verificación de salud falló (${this.consecutiveFailures}/${this.maxHealthFailures}): ${error.message}`,
        "warn",
      );

      if (this.consecutiveFailures >= this.maxHealthFailures) {
        this.emit("alert", {
          message: `WhatsApp no responde a las verificaciones (${this.consecutiveFailures} fallos seguidos). Reiniciando cliente.`,
          level: "error",
          key: "health",
        });
        await this.#restart("health_check_failed");
      }
    }
  }

  #isBrowserConnected() {
    try {
      if (!this.client) return false;
      if (!this.client.pupBrowser) return false;
      if (typeof this.client.pupBrowser.isConnected !== "function") return true;
      return this.client.pupBrowser.isConnected();
    } catch {
      return false;
    }
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateSince = Date.now();
    this.emit("state", state);
  }

  #resolveReadyWaiters(value) {
    for (const waiter of [...this.readyWaiters]) waiter(value);
    this.readyWaiters.clear();
  }
}
