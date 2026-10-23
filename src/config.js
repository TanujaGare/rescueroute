import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

/**
 * Loads configuration from the environment. A local .env file is read with
 * Node's built-in loader so no secrets ever live in source code.
 */
export function loadConfig(overrides = {}) {
  if (!overrides.skipEnvFile && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const env = process.env;
  const nodeEnv = env.NODE_ENV || 'development';

  let sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) {
    if (nodeEnv === 'production') {
      throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
    }
    // Development only: an ephemeral secret means sessions reset on restart.
    sessionSecret = randomBytes(32).toString('hex');
  }

  return {
    nodeEnv,
    port: toInt(env.PORT, 8080),
    dbPath: env.DB_PATH || 'data/rescueroute.db',
    trustProxy: env.TRUST_PROXY === 'true',
    sessionSecret,
    sessionTtlSeconds: toInt(env.SESSION_TTL_SECONDS, 8 * 3600),
    demoPassword: env.DEMO_PASSWORD || 'tanuja',
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-3.5-flash',
      // Tried in order when the primary model is overloaded (503), rate limited or not found.
      fallbackModels: (env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean),
    },
    agent: {
      maxModelTurns: toInt(env.AGENT_MAX_TURNS, 12),
      maxToolCalls: toInt(env.AGENT_MAX_TOOL_CALLS, 60),
      modelTimeoutMs: toInt(env.AGENT_MODEL_TIMEOUT_MS, 25_000),
      modelRetries: toInt(env.AGENT_MODEL_RETRIES, 2),
      rateLimitBackoffMs: toInt(env.AGENT_RATE_LIMIT_BACKOFF_MS, 8_000),
      runBudgetMs: toInt(env.AGENT_RUN_BUDGET_MS, 120_000),
    },
    ...overrides,
  };
}

function toInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
