import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT_KEYLEN = 64;
const MAX_TOKEN_LENGTH = 2048;
const scryptAsync = promisify(scrypt);

/** Synchronous hash, used only when seeding accounts at startup. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/**
 * Verifies a password without blocking the event loop (scrypt runs on the
 * libuv thread pool), using a constant-time comparison.
 */
export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Compared against when an email is unknown, so response time does not reveal which accounts exist. */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString('hex'));

/** Compact signed token: base64url(payload).base64url(HMAC-SHA256). */
export function signToken(payload, secret, ttlSeconds, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }),
  ).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Express middleware: requires a valid bearer token and loads the user. */
export function requireAuth({ repo, config, clock = () => Date.now() }) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, config.sessionSecret, clock());
    const user = payload && repo.findUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } });
    }
    req.user = user;
    next();
  };
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: `Requires ${role} role` } });
    }
    next();
  };
}
