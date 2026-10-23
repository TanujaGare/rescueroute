import { createRuntime } from './bootstrap.js';

const { app, db, config, logger, model, orchestrator } = createRuntime();

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
