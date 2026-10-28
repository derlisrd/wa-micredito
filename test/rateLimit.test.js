import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../services/rateLimit.js";

function createReq(ip = "1.2.3.4", path = "/send") {
  return { ip, path, headers: {}, socket: { remoteAddress: ip } };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function call(limiter, req, res) {
  let passed = false;
  limiter.middleware(req, res, () => {
    passed = true;
  });
  return passed;
}

describe("RateLimiter", () => {
  it("permite hasta el máximo y luego responde 429", (t) => {
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 });
    t.after(() => limiter.close());

    const req = createReq();

    for (let i = 0; i < 3; i += 1) {
      const res = createRes();
      assert.equal(call(limiter, req, res), true, `request ${i + 1} debe pasar`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["ratelimit-remaining"], 2 - i);
    }

    const blocked = createRes();
    assert.equal(call(limiter, req, blocked), false);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.success, false);
    assert.ok(blocked.headers["retry-after"] >= 1);
    assert.equal(blocked.headers["ratelimit-remaining"], 0);
  });

  it("cuenta por IP y no mezcla clientes", (t) => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    t.after(() => limiter.close());

    assert.equal(call(limiter, createReq("10.0.0.1"), createRes()), true);
    assert.equal(call(limiter, createReq("10.0.0.1"), createRes()), false);
    assert.equal(call(limiter, createReq("10.0.0.2"), createRes()), true);
  });

  it("se resetea al terminar la ventana", async (t) => {
    const limiter = new RateLimiter({ max: 1, windowMs: 40 });
    t.after(() => limiter.close());

    const req = createReq();
    assert.equal(call(limiter, req, createRes()), true);
    assert.equal(call(limiter, req, createRes()), false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(call(limiter, req, createRes()), true);
  });

  it("respeta skip", (t) => {
    const limiter = new RateLimiter({
      max: 1,
      windowMs: 60_000,
      skip: (req) => req.path === "/health",
    });
    t.after(() => limiter.close());

    const healthReq = createReq("1.1.1.1", "/health");
    for (let i = 0; i < 10; i += 1) {
      assert.equal(call(limiter, healthReq, createRes()), true);
    }
  });

  it("se puede desactivar", (t) => {
    const limiter = new RateLimiter({ max: 1, enabled: false });
    t.after(() => limiter.close());

    const req = createReq();
    for (let i = 0; i < 10; i += 1) {
      assert.equal(call(limiter, req, createRes()), true);
    }
  });

  it("no crece sin límite con muchas IPs", (t) => {
    const limiter = new RateLimiter({ max: 10, windowMs: 60_000, maxEntries: 5 });
    t.after(() => limiter.close());

    for (let i = 0; i < 20; i += 1) {
      call(limiter, createReq(`10.0.0.${i}`), createRes());
    }

    assert.ok(limiter.buckets.size <= 5);
  });

  it("expone headers RateLimit", (t) => {
    const limiter = new RateLimiter({ max: 10, windowMs: 60_000 });
    t.after(() => limiter.close());

    const res = createRes();
    call(limiter, createReq(), res);

    assert.equal(res.headers["ratelimit-limit"], 10);
    assert.equal(res.headers["ratelimit-remaining"], 9);
    assert.ok(res.headers["ratelimit-reset"] >= 1);
  });
});
