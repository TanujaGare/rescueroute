# Security policy

## Reporting a vulnerability
Please open a private security advisory on this repository (Security → Advisories → Report a vulnerability) rather than a public issue. Include steps to reproduce and the affected endpoint or file.

## Threat model summary
RescueRoute lets an AI model *propose* actions, so the main risks are a model or untrusted data causing unsafe or unauthorised effects. The design principle is: **the model proposes, code verifies, a human approves.**

| Asset | Threat | Control | Where |
|---|---|---|---|
| Gemini API key | Leakage via repo, browser, logs | Server-side env var only; `.env` git-ignored; never sent to the client; keys redacted from error text | `src/config.js`, `src/agent/orchestrator.js` (`safeError`) |
| Dispatch decisions | Model or prompt injection approving or skewing deliveries | Model has no approval tool; strict tool allow-list (`Object.hasOwn`); Zod `.strict()` arguments; donor notes marked untrusted | `src/agent/tools.js` |
| Food safety | Infeasible plans (expired food, broken cold chain, overloads) | 11 hard constraints checked in code at proposal time and again against fresh DB state before saving | `src/domain/planning.js`, `verifyAgainstDatabase` |
| Inventory integrity | Double allocation under concurrency | `BEGIN IMMEDIATE` transactions, conditional claim (`status='open' AND expires_at > now`), partial unique index | `src/db/` |
| User data | Cross-user access (IDOR) | Every run and dispatch query is scoped by `user_id`; other users get 404 | `src/db/repository.js` |
| Accounts | Credential stuffing, token forgery | Async (non-blocking) scrypt hashes, HMAC-SHA256 tokens with expiry, constant-time comparison, dummy-hash check so unknown emails are indistinguishable by timing, login rate limit | `src/security/auth.js`, `src/http/routes/auth.js` |
| Browser | XSS, clickjacking | Strict CSP (no inline script), `textContent` rendering enforced by ESLint, `frame-ancestors 'none'` | `src/http/middleware.js`, `eslint.config.js` |
| Availability and cost | Abuse, runaway agent loops | Rate limits, 16 KB body limit, model timeout and retry limits, turn, tool and time budgets, one run at a time | `src/http/`, `src/agent/model-loop.js` |
| Accountability | Untraceable actions | Audit log for logins, runs, fallbacks, verification rejections, approvals and deliveries | `audit_log` table |

## Verifying the controls
```bash
npm run lint        # ESLint (incl. innerHTML ban) + syntax guards
npm test            # includes auth, RBAC, IDOR, injection, budget and concurrency tests
npm run audit       # production dependency audit
```

## Known limitations
- Demo accounts and passwords are seeded for evaluators; production would use Firebase Authentication or another identity provider.
- SQLite on free hosting is ephemeral; production would use a managed database with backups.
- Travel times are estimates (straight-line distance × 1.35); there is no live traffic data.
