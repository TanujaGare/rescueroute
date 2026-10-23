import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';

const JSON_BODY_LIMIT = '16kb';
const ONE_YEAR_SECONDS = 31_536_000;
const ONE_DAY_SECONDS = 86_400;

/** Uniform JSON error body: { error: { code, message, ...extra } }. */
export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

/** Strict CSP: only same-origin scripts, styles and requests; no framing. */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
}

/** gzip/brotli-negotiated compression for JSON and static assets. */
export const compress = () => compression();

export const jsonBody = () => express.json({ limit: JSON_BODY_LIMIT });

/** Adds a request id and logs one structured line per API request (no bodies, tokens or passwords). */
export function requestLogger(logger) {
  return (req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api') && req.path !== '/healthz') return;
      logger.info('http', {
        id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        user: req.user?.id,
      });
    });
    next();
  };
}

/** Rate limiter factory; keyByUser limits per signed-in user instead of per IP. */
export function createLimiter(limit, windowMs, { keyByUser = false } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyByUser ? { keyGenerator: (req) => req.user.id } : {}),
    handler: (req, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests, slow down.'),
  });
}

/**
 * Static files: HTML is always revalidated; CSS and JS are referenced with a
 * version query string, so they can be cached for a year.
 */
export function staticFiles(dir) {
  return express.static(dir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
      else res.setHeader('Cache-Control', `public, max-age=${ONE_DAY_SECONDS}`);
    },
  });
}

/** Central error handler: never leaks stack traces to clients. */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by their four parameters
  return (err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return sendError(res, err.status ?? 400, 'BAD_REQUEST', 'Malformed or oversized JSON body');
    }
    logger.error('unhandled', { id: req.id, error: String(err?.message ?? err).slice(0, 200) });
    return sendError(res, 500, 'INTERNAL', 'Unexpected error', { request_id: req.id });
  };
}
