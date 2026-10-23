import request from 'supertest';
import { openDatabase } from '../src/db/database.js';
import { createRepository } from '../src/db/repository.js';
import { seedDemoData } from '../src/db/seed.js';
import { createOrchestrator } from '../src/agent/orchestrator.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const PASSWORD = 'test-password-123';
export const NOW = Date.parse('2026-10-23T12:00:00Z');

/** Builds a fully wired app on an in-memory database with a fixed clock. */
export function buildTestApp({ model = null, agent = {} } = {}) {
  const clock = () => NOW;
  const config = loadConfig({ skipEnvFile: true, sessionSecret: 'x'.repeat(40), demoPassword: PASSWORD });
  config.agent = { ...config.agent, modelTimeoutMs: 200, modelRetries: 1, rateLimitBackoffMs: 5, ...agent };
  const db = openDatabase(':memory:');
  seedDemoData(db, { now: NOW, demoPassword: PASSWORD });
  const repo = createRepository(db, clock);
  const logger = createLogger({ silent: true });
  const orchestrator = createOrchestrator({ repo, config, model, clock, logger });
  const app = createApp({ db, repo, config, orchestrator, logger, clock, model });
  return { app, db, repo, orchestrator, config };
}

export async function login(app, email = 'coordinator@rescueroute.demo') {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.body.token;
}

/** A fake model that replays a fixed script of tool calls, one entry per turn. */
export function scriptedModel(turns, name = 'fake-model') {
  let turn = 0;
  const seen = [];
  return {
    name,
    seen,
    async generate({ contents }) {
      seen.push(contents.length);
      const step = turns[Math.min(turn++, turns.length - 1)];
      if (typeof step === 'function') return step();
      const functionCalls = step.map(([callName, args], i) => ({ id: `c${turn}_${i}`, name: callName, args }));
      return {
        content: { role: 'model', parts: functionCalls.map((fc) => ({ functionCall: fc })) },
        functionCalls,
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

export async function runAndWait(orchestrator, repo, objective = 'Rescue as much food as possible') {
  const { runId, done } = orchestrator.start({ id: 'usr_coord' }, objective);
  await done;
  return repo.getRunForUser(runId, 'usr_coord');
}
