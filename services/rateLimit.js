/**
 * Rate limiter en memoria con ventana fija.
 *
 * La app corre en un solo proceso (WhatsApp Web no permite varias sesiones
 * concurrentes), así que no hace falta Redis ni una dependencia externa.
 *
 * Clave por defecto: IP del cliente. Detrás de Nginx hay que configurar
 * `TRUST_PROXY` para que `req.ip` sea la IP real y no 127.0.0.1.
 */
export class RateLimiter {
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs ?? 60_000);
    this.max = Number(options.max ?? 120);
    this.enabled = options.enabled !== false;
    this.message =
      options.message ?? "Demasiadas solicitudes. Esperá un momento y reintentá.";
    this.keyGenerator = options.keyGenerator ?? defaultKeyGenerator;
    this.skip = options.skip ?? (() => false);
    this.maxEntries = Number(options.maxEntries ?? 50_000);

    this.buckets = new Map();
    this.cleanupTimer = null;

    if (this.enabled) this.#startCleanup();
  }

  middleware = (req, res, next) => {
    if (!this.enabled || this.skip(req)) return next();

    const key = this.keyGenerator(req);
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
      this.#enforceLimitSize(now);
    }

    bucket.count += 1;

    const remaining = Math.max(0, this.max - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader("RateLimit-Limit", this.max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetSeconds);

    if (bucket.count > this.max) {
      res.setHeader("Retry-After", resetSeconds);
      return res.status(429).json({
        success: false,
        message: this.message,
        retryAfterSeconds: resetSeconds,
      });
    }

    return next();
  };

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  #startCleanup() {
    // Limpia ventanas vencidas para que el Map no crezca sin control.
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(key);
      }
    }, Math.max(this.windowMs, 5_000));
    this.cleanupTimer.unref?.();
  }

  #enforceLimitSize(now) {
    if (this.buckets.size < this.maxEntries) return;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }

    // Si sigue lleno (muchas IPs distintas), vaciamos para priorizar
    // disponibilidad antes que memoria.
    if (this.buckets.size >= this.maxEntries) this.buckets.clear();
  }
}

export function defaultKeyGenerator(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
