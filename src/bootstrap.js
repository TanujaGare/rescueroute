import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRepository } from './db/repository.js';
import { seedDemoData } from './db/seed.js';
import { createGeminiModel } from './agent/gemini.js';
import { createOrchestrator } from './agent/orchestrator.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

/**
 * Wires configuration, database, Gemini, orchestrator and HTTP app.
 * Shared by the long-running server (src/server.js) and the Vercel
 * serverless entry (api/index.js).
 */
export function createRuntime() {
  const logger = createLogger();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const repo = createRepository(db);

  if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    seedDemoData(db, { demoPassword: config.demoPassword });
    logger.info('db.seeded', { path: config.dbPath });
  }

  const model = createGeminiModel(config.gemini);
  if (!model) logger.warn('gemini.disabled', { reason: 'GEMINI_API_KEY not set; runs will use the deterministic fallback' });
  else logger.info('gemini.configured', { model: model.name, note: 'Not yet verified; use POST /api/planner/check or run the agent.' });

  const orchestrator = createOrchestrator({ repo, config, model, logger });
  const app = createApp({ db, repo, config, orchestrator, logger, model });
  return { app, db, config, logger, model, orchestrator };
}
