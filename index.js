import crypto from "node:crypto";
import express from "express";
import dotenv from "dotenv";
import qrcode from "qrcode-terminal";
import { WhatsAppService } from "./services/whatsapp.js";
import { createNotifier, toChatId } from "./services/notifier.js";
import { RateLimiter } from "./services/rateLimit.js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SEND_WAIT_MS = Number(process.env.SEND_WAIT_MS || 10_000);
const GROUP_CACHE_TTL_MS = Number(process.env.GROUP_CACHE_TTL_MS || 10 * 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60_000);
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== "false";

function parseTrustProxy(value) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(String(value))) return Number(value);
  return value; // "loopback", "uniquelocal", etc.
}

const wa = new WhatsAppService({
  sessionPath: process.env.SESSION_PATH || "./session",
  watchdogIntervalMs: Number(process.env.WATCHDOG_INTERVAL_MS || 30_000),
  minReconnectDelayMs: Number(process.env.RECONNECT_MIN_DELAY_MS || 5_000),
  maxReconnectDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 60_000),
  maxReconnectAttempts: Number(process.env.MAX_RECONNECT_ATTEMPTS || 20),
  initTimeoutMs: Number(process.env.INIT_TIMEOUT_MS || 120_000),
  qrMaxAgeMs: Number(process.env.QR_MAX_AGE_MS || 10 * 60_000),
});

const notifier = createNotifier({ service: wa });

/* ------------------------------------------------------------------------- */
/* Eventos del cliente de WhatsApp                                            */
/* ------------------------------------------------------------------------- */

wa.on("log", (message, level) => notifier.log(message, level));

wa.on("qr", (qr) => {
  notifier.log("🔐 Escaneá este QR con WhatsApp:", "warn");
  qrcode.generate(qr, { small: true });
});

wa.on("ready", () => {
  void notifier.alert("WhatsApp reconectado y operativo", "info", "recovered");
  void notifier.flushWhatsApp();
});

wa.on("reconnecting", ({ attempt, delayMs, reason }) => {
  const delay = delayMs >= 1000 ? `${(delayMs / 1000).toFixed(0)} s` : `${delayMs} ms`;
  void notifier.alert(
    `WhatsApp no está disponible (${reason}). Reintento ${attempt} en ${delay}.`,
    "error",
    "connection",
  );
});

wa.on("alert", ({ message, level = "error", key = "general" }) => {
  void notifier.alert(message, level, key);
});

wa.on("exhausted", () => {
  void notifier.alert(
    "Se agotaron los intentos de reconexión de WhatsApp. Reiniciando el proceso para empezar de cero.",
    "error",
    "exhausted",
  );
  void shutdown("reconnect_exhausted", new Error("Sin conexión con WhatsApp"));
});

/* ------------------------------------------------------------------------- */
/* API HTTP                                                                   */
/* ------------------------------------------------------------------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
app.use(express.json({ limit: "1mb" }));

const generalLimiter = new RateLimiter({
  enabled: RATE_LIMIT_ENABLED,
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  skip: (req) => req.path === "/health",
  message: "Demasiadas solicitudes. Esperá un momento y reintentá.",
});

const sendLimiter = new RateLimiter({
  enabled: RATE_LIMIT_ENABLED,
  windowMs: Number(process.env.RATE_LIMIT_SEND_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_SEND_MAX || 30),
  message:
    "Límite de envíos alcanzado. Esperá antes de mandar más mensajes (protege tu número de WhatsApp).",
});

const restartLimiter = new RateLimiter({
  enabled: RATE_LIMIT_ENABLED,
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_RESTART_MAX || 5),
  message: "Demasiados reinicios solicitados. Esperá un minuto.",
});

const limiters = [generalLimiter, sendLimiter, restartLimiter];

app.use(generalLimiter.middleware);

const apiKeyMiddleware = (req, res, next) => {
  const provided = String(req.headers["x-api-key"] ?? "");
  const expected = String(process.env.API_KEY ?? "");

  const valid =
    expected.length > 0 &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!valid) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

/** Health-check simple para monitoreo externo (sin datos sensibles). */
app.get("/health", (req, res) => {
  const snapshot = wa.status();
  res.status(snapshot.isReady ? 200 : 503).json({
    status: snapshot.isReady ? "ok" : "degraded",
    whatsapp: snapshot.state,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/** Estado detallado del servicio (requiere API key). */
app.get("/status", apiKeyMiddleware, (req, res) => {
  res.json({ success: true, whatsapp: wa.status() });
});

/** Fuerza un reinicio del cliente de WhatsApp (requiere API key). */
app.post("/restart", restartLimiter.middleware, apiKeyMiddleware, (req, res) => {
  void wa.restart("manual");
  res.json({ success: true, message: "Reinicio de WhatsApp solicitado" });
});

/** Envía un mensaje a un número. */
app.post("/send", sendLimiter.middleware, apiKeyMiddleware, async (req, res) => {
  const { number, text } = req.body ?? {};

  if (!number || !text) {
    return res.status(400).json({ success: false, message: "Faltan datos" });
  }

  const ready = await wa.waitUntilReady(SEND_WAIT_MS);
  if (!ready) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp no está conectado en este momento, reintentá en unos segundos",
      state: wa.state,
    });
  }

  const chatId = toChatId(number);
  if (!chatId) {
    return res.status(400).json({ success: false, message: "Número inválido" });
  }

  try {
    await wa.sendMessage(chatId, text);
    res.json({ success: true, message: "Mensaje enviado" });
  } catch (err) {
    wa.handleSendError(err);
    res.status(500).json({ success: false, message: "Error al enviar mensaje" });
  }
});

const groupCache = new Map();

async function findGroupId(name) {
  const cached = groupCache.get(name);
  if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL_MS) {
    return cached.id;
  }

  const chats = await wa.getChats();
  const grupo = chats.find((chat) => chat.isGroup && chat.name === name);

  if (!grupo) {
    groupCache.delete(name);
    return null;
  }

  const id = grupo.id._serialized;
  groupCache.set(name, { id, cachedAt: Date.now() });
  return id;
}

/** Envía un mensaje a un grupo por nombre. */
app.post("/send/grupo-noti", sendLimiter.middleware, apiKeyMiddleware, async (req, res) => {
  const { text, name } = req.body ?? {};

  if (!text || !name) {
    return res
      .status(400)
      .json({ success: false, message: "Faltan los campos 'text' y 'name' en el body" });
  }

  const ready = await wa.waitUntilReady(SEND_WAIT_MS);
  if (!ready) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp no está conectado en este momento, reintentá en unos segundos",
      state: wa.state,
    });
  }

  try {
    const groupId = await findGroupId(name);

    if (!groupId) {
      return res.status(404).json({
        success: false,
        message: `No se encontró ningún grupo llamado '${name}'`,
      });
    }

    await wa.sendMessage(groupId, text);

    res.json({
      success: true,
      message: `Mensaje enviado al grupo: ${name}`,
      groupId,
    });
  } catch (err) {
    groupCache.delete(name);
    wa.handleSendError(err);
    res.status(500).json({ success: false, message: "Error interno al enviar el mensaje" });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Ruta no encontrada" });
});

/* ------------------------------------------------------------------------- */
/* Arranque y apagado                                                         */
/* ------------------------------------------------------------------------- */

let shuttingDown = false;

const server = app.listen(PORT, HOST);

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = Math.min(15_000, REQUEST_TIMEOUT_MS);
server.keepAliveTimeout = 5_000;

server.on("listening", () => {
  notifier.log(
    `Servidor API WhatsApp escuchando en http://${HOST}:${PORT}`,
    "info",
  );
});

server.on("error", (error) => {
  void shutdown("server_error", error);
});

async function shutdown(signal, error) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (error) {
    await notifier.alert(
      `Servicio detenido por ${signal}: ${error.message}. ` +
        "Si corre bajo pm2/systemd se reiniciará automáticamente.",
      "error",
      `fatal_${signal}`,
    );
  } else {
    notifier.log(`Deteniendo servicio (${signal})…`, "warn");
  }

  await Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
  ]);

  await wa.stop();
  for (const limiter of limiters) limiter.close();
  process.exit(error ? 1 : 0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
  if (shuttingDown) return;
  void shutdown("uncaughtException", error);
});

// whatsapp-web.js rechaza promesas internas al destruir el navegador
// ("Execution context was destroyed"). Eso no debe tumbar el proceso: el
// watchdog y la reconexión se encargan del cliente.
process.on("unhandledRejection", (reason) => {
  if (shuttingDown) return;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void notifier.alert(
    `Promesa rechazada sin manejar (el servicio sigue funcionando): ${error.message}`,
    "error",
    "unhandled_rejection",
  );
});

// Arranca la conexión sin bloquear el servidor HTTP.
void wa.start().catch((error) => {
  notifier.log(`Error inesperado al iniciar WhatsApp: ${error.message}`, "error");
  void wa.restart("start_failed");
});

export { app, wa, notifier };
