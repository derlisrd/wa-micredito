import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WhatsAppService, WA_STATE } from "../services/whatsapp.js";

class FakeBrowser extends EventEmitter {
  #connected = true;

  isConnected() {
    return this.#connected;
  }

  process() {
    return { pid: undefined };
  }

  async close() {
    this.#connected = false;
    this.emit("disconnected");
  }
}

class FakeClient extends EventEmitter {
  constructor(behavior = {}) {
    super();
    this.behavior = behavior;
    this.pupBrowser = new FakeBrowser();
    this.info = null;
    this.destroyed = false;
  }

  async initialize() {
    if (this.behavior.init === "hang") return new Promise(() => {});
    if (this.behavior.init === "reject") {
      throw new Error(this.behavior.initMessage ?? "init boom");
    }

    setTimeout(() => {
      if (this.destroyed) return;
      this.info = { wid: "123@c.us" };
      this.emit("ready");
    }, 5);
  }

  async getState() {
    if (this.behavior.state === "throw") throw new Error("detached Frame");
    return this.behavior.state ?? "CONNECTED";
  }

  async sendMessage(chatId, text) {
    if (this.behavior.send === "throw") throw new Error("Session closed");
    return { chatId, text };
  }

  async destroy() {
    this.destroyed = true;
    await this.pupBrowser.close();
  }
}

function linkExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeout = 3_000, interval = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return Boolean(await predicate());
}

function createService(t, behavior = {}, overrides = {}) {
  const clients = [];
  const service = new WhatsAppService({
    clientFactory: () => {
      const client = new FakeClient(behavior);
      clients.push(client);
      return client;
    },
    watchdogIntervalMs: 40,
    minReconnectDelayMs: 20,
    maxReconnectDelayMs: 40,
    maxReconnectAttempts: 10,
    initTimeoutMs: 200,
    stateTimeoutMs: 100,
    destroyTimeoutMs: 200,
    maxHealthFailures: 3,
    ...overrides,
  });

  t.after(async () => {
    await service.stop();
  });

  return { service, clients };
}

describe("WhatsAppService", () => {
  it("conecta, envía mensajes y se reconecta al desconectarse", async (t) => {
    const { service, clients } = createService(t);
    const events = [];
    for (const name of ["reconnecting", "ready", "alert"]) {
      service.on(name, (payload) => events.push([name, payload]));
    }

    await service.start();
    assert.ok(await waitFor(() => service.isReady));
    assert.equal(service.state, WA_STATE.READY);

    const sent = await service.sendMessage("595981123456@c.us", "hola");
    assert.equal(sent.text, "hola");

    clients[0].emit("disconnected", "LOGOUT");
    assert.ok(
      await waitFor(() => clients.length === 2 && service.isReady),
      "debe crear un cliente nuevo y volver a estar listo",
    );
    assert.equal(clients[0].destroyed, true);
    assert.ok(events.some(([name]) => name === "reconnecting"));
    assert.ok(events.some(([name]) => name === "alert"), "LOGOUT debe avisar");
  });

  it("reinicia el cliente cuando el health-check falla 3 veces", async (t) => {
    const { service, clients } = createService(t, { state: "throw" });
    await service.start();
    assert.ok(await waitFor(() => service.isReady));
    assert.equal(clients.length, 1);

    assert.ok(
      await waitFor(() => clients.length >= 2, { timeout: 2_000 }),
      "el watchdog debe reiniciar el cliente",
    );
  });

  it("emite 'exhausted' al agotar los intentos de reconexión", async (t) => {
    const { service } = createService(t, { init: "reject" }, { maxReconnectAttempts: 2 });
    let exhausted = false;
    service.on("exhausted", () => {
      exhausted = true;
    });

    await service.start();
    assert.ok(await waitFor(() => exhausted));
  });

  it("corta una inicialización colgada y reintenta", async (t) => {
    const { service, clients } = createService(t, { init: "hang" }, { initTimeoutMs: 60 });
    await service.start();
    assert.ok(await waitFor(() => clients.length >= 2, { timeout: 2_000 }));
  });

  it("reinicia ante un error de envío con sesión rota", async (t) => {
    const { service, clients } = createService(t, { send: "throw" });
    await service.start();
    assert.ok(await waitFor(() => service.isReady));

    await assert.rejects(() => service.sendMessage("1@c.us", "x"), /Session closed/);
    assert.equal(service.handleSendError(new Error("Session closed")), true);
    assert.ok(await waitFor(() => clients.length >= 2, { timeout: 2_000 }));
  });

  it("no considera errores de envío genéricos como sesión rota", async (t) => {
    const { service } = createService(t);
    await service.start();
    assert.ok(await waitFor(() => service.isReady));
    assert.equal(service.handleSendError(new Error("Número inválido")), false);
  });

  it("waitUntilReady responde false al vencer el plazo", async (t) => {
    const { service } = createService(t, { init: "hang" }, { initTimeoutMs: 5_000 });
    void service.start();

    assert.equal(await service.waitUntilReady(50), false);
    assert.equal(service.state === WA_STATE.READY, false);
  });

  it("waitUntilReady resuelve true cuando el cliente está listo", async (t) => {
    const { service } = createService(t);
    const ready = service.waitUntilReady(2_000);
    void service.start();
    assert.equal(await ready, true);
  });

  it("limpia un SingletonLock huérfano y reintenta", async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "wa-lock-"));
    const profileDir = path.join(base, "session");
    await mkdir(profileDir, { recursive: true });

    const lockPath = path.join(profileDir, "SingletonLock");

    // PID de un proceso que ya terminó: simula un cierre con SIGKILL.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid;
    await new Promise((resolve) => child.on("exit", resolve));

    await symlink(`host-${deadPid}`, lockPath);

    const { service, clients } = createService(
      t,
      {
        init: "reject",
        initMessage:
          "The browser is already running for /tmp/x. Use a different `userDataDir` or stop the running browser first.",
      },
      { sessionPath: base, maxReconnectAttempts: 3 },
    );

    t.after(() => rm(base, { recursive: true, force: true }));

    await service.start();

    assert.ok(await waitFor(() => !linkExists(lockPath)), "debe borrar el lock huérfano");
    assert.ok(await waitFor(() => clients.length >= 2), "debe reintentar la conexión");
  });

  it("no toca el perfil si otra instancia viva lo está usando", async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "wa-lock-alive-"));
    const profileDir = path.join(base, "session");
    await mkdir(profileDir, { recursive: true });

    const lockPath = path.join(profileDir, "SingletonLock");
    await symlink(`host-${process.pid}`, lockPath);

    const { service } = createService(
      t,
      {
        init: "reject",
        initMessage: "The browser is already running for /tmp/x.",
      },
      { sessionPath: base, maxReconnectAttempts: 2 },
    );

    const alerts = [];
    service.on("alert", (alert) => alerts.push(alert));
    t.after(() => rm(base, { recursive: true, force: true }));

    await service.start();
    assert.ok(await waitFor(() => service.reconnectAttempts >= 1));

    assert.equal(linkExists(lockPath), true, "no debe borrar el lock de un proceso vivo");
    assert.ok(
      alerts.some((alert) => alert.key === "profile_locked"),
      "debe avisar que hay otra instancia",
    );
  });
});
