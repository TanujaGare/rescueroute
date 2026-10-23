import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRepository } from './db/repository.js';
import { seedDemoData } from './db/seed.js';
import { createGeminiModel } from './agent/gemini.js';
import { createOrchestrator } from './agent/orchestrator.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

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

const server = app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, gemini_configured: !!model });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.stopping', { signal });
  server.close();
  // Let an in-flight agent run finish (bounded by its own time budget).
  await Promise.race([orchestrator.idle(), new Promise((r) => setTimeout(r, 10_000))]);
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
