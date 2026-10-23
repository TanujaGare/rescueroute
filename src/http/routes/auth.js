import express from 'express';
import { DUMMY_PASSWORD_HASH, signToken, verifyPassword } from '../../security/auth.js';
import { loginSchema, parseBody } from '../../validation.js';
import { createLimiter, sendError } from '../middleware.js';

const FIFTEEN_MINUTES = 15 * 60_000;
const DEMO_SESSION_SECONDS = 2 * 3600;
const DEMO_USER_ID = 'usr_demo';

/** Sign-in routes: password login and the optional one-click demo session. */
export function authRoutes({ repo, config, clock, auth }) {
  const router = express.Router();
  const issueToken = (user, ttl) => signToken({ sub: user.id, role: user.role }, config.sessionSecret, ttl, clock());

  router.post('/auth/login', createLimiter(10, FIFTEEN_MINUTES), async (req, res) => {
    const body = parseBody(loginSchema, req, res);
    if (!body) return;
    const user = repo.findUserByEmail(body.email);
    // Always run the (async, non-blocking) hash comparison so unknown emails take the same time.
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) return sendError(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    repo.audit(user.id, 'auth.login', null, null);
    res.json({
      token: issueToken(user, config.sessionTtlSeconds),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  });

  // One-click demo access: signs in as a dedicated guest coordinator with its own run history.
  router.post('/auth/demo', createLimiter(20, FIFTEEN_MINUTES), (req, res) => {
    const user = config.demoLoginEnabled ? repo.findUserById(DEMO_USER_ID) : null;
    if (!user) return sendError(res, 404, 'DEMO_DISABLED', 'Demo access is not enabled');
    repo.audit(user.id, 'auth.demo', null, null);
    res.json({ token: issueToken(user, Math.min(config.sessionTtlSeconds, DEMO_SESSION_SECONDS)), user });
  });

  router.get('/me', auth, (req, res) => res.json({ user: req.user }));
  return router;
}
