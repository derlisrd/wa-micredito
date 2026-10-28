import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { Notifier, toChatId } from "../services/notifier.js";

async function startWebhook(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { requests, url: `http://127.0.0.1:${port}/hook` };
}

describe("toChatId", () => {
  it("normaliza teléfonos y respeta ids de chat", () => {
    assert.equal(toChatId("595 981 123 456"), "595981123456@c.us");
    assert.equal(toChatId("595981123456@g.us"), "595981123456@g.us");
    assert.equal(toChatId(""), "");
    assert.equal(toChatId(undefined), "");
  });
});

describe("Notifier", () => {
  it("envía el webhook con token y payload", async (t) => {
    const { requests, url } = await startWebhook(t);
    const notifier = new Notifier({
      silent: true,
      webhookUrl: url,
      webhookToken: "secreto",
      throttleMs: 0,
    });

    await notifier.alert("se cayó WhatsApp", "error", "connection");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, "Bearer secreto");
    assert.equal(requests[0].body.service, "wa-micredito");
    assert.equal(requests[0].body.key, "connection");
    assert.equal(requests[0].body.level, "error");
    assert.match(requests[0].body.text, /se cayó WhatsApp/);
    assert.ok(requests[0].body.timestamp);
  });

  it("silencia alertas repetidas de la misma key", async (t) => {
    const { requests, url } = await startWebhook(t);
    const notifier = new Notifier({
      silent: true,
      webhookUrl: url,
      throttleMs: 5_000,
    });

    await notifier.alert("falla 1", "error", "connection");
    await notifier.alert("falla 2", "error", "connection");

    assert.equal(requests.length, 1);

    await notifier.alert("otra falla", "error", "health");
    assert.equal(requests.length, 2);
  });

  it("encola avisos de WhatsApp y los envía al reconectar", async () => {
    const sent = [];
    const service = {
      isReady: false,
      async sendMessage(chatId, text) {
        if (!this.isReady) throw new Error("not ready");
        sent.push({ chatId, text });
      },
    };

    const notifier = new Notifier({
      silent: true,
      service,
      adminNumber: "595 981 123 456",
      throttleMs: 0,
    });

    await notifier.alert("WhatsApp caído", "error", "connection");
    assert.equal(sent.length, 0);
    assert.equal(notifier.pendingWhatsApp.length, 1);

    service.isReady = true;
    await notifier.flushWhatsApp();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "595981123456@c.us");
    assert.match(sent[0].text, /WhatsApp caído/);
    assert.equal(notifier.pendingWhatsApp.length, 0);
  });

  it("limita la cola de avisos pendientes", async () => {
    const notifier = new Notifier({
      silent: true,
      service: { isReady: false, sendMessage: async () => {} },
      adminNumber: "595981123456",
      throttleMs: 0,
    });

    for (let i = 0; i < 30; i += 1) {
      await notifier.alert(`aviso ${i}`, "error", `key-${i}`);
    }

    assert.equal(notifier.pendingWhatsApp.length, notifier.maxPending);
  });
});
