/**
 * Manual live verification of the real Gemini integration (not mocked).
 * 1. Sends a minimal request to prove the key and model work.
 * 2. Runs one full agent workflow on an in-memory copy of the demo data and
 *    prints each stage's real status and duration.
 *
 * Usage: npm run check:gemini   (requires GEMINI_API_KEY in .env)
 */
import { loadConfig } from '../src/config.js';
import { createGeminiModel, classifyGeminiError } from '../src/agent/gemini.js';
import { openDatabase } from '../src/db/database.js';
import { createRepository } from '../src/db/repository.js';
import { seedDemoData } from '../src/db/seed.js';
import { createOrchestrator } from '../src/agent/orchestrator.js';

const config = loadConfig();
const model = createGeminiModel(config.gemini);
if (!model) {
  console.error('FAIL  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key from https://aistudio.google.com/apikey');
  process.exit(1);
}

console.log(`Models: ${model.models.join(' -> ')}`);
const t0 = Date.now();
try {
  const { text } = await model.ping({ signal: AbortSignal.timeout(config.agent.modelTimeoutMs) });
  console.log(`PASS  Live request succeeded in ${Date.now() - t0} ms (reply: "${text}")`);
} catch (err) {
  const e = classifyGeminiError(err);
  console.error(`FAIL  ${e.code}: ${e.message}`);
  process.exit(1);
}

const db = openDatabase(':memory:');
seedDemoData(db, { demoPassword: 'live-check-only' });
const repo = createRepository(db);
const orchestrator = createOrchestrator({ repo, config, model });
const { runId, done } = orchestrator.start({ id: 'usr_coord' }, 'Route all open donations to NGOs before they expire, prioritising perishables.');
await done;
const run = repo.getRunForUser(runId, 'usr_coord');
console.log(`\nRun ${run.status}, planner: ${run.planner_mode}, model(s): ${run.model}${run.fallback_reason ? `, fallback: ${run.fallback_reason}` : ''}`);
for (const s of run.stages) console.log(`  ${s.status.padEnd(8)} ${String(s.duration_ms ?? '-').padStart(6)} ms  ${s.label}: ${s.summary ?? ''}`);
const m = run.metrics ?? {};
console.log(`\nGemini calls ${m.model_successes}/${m.model_calls}, proposals ${m.proposals_generated} generated / ${m.proposals_validated} valid / ${m.proposals_saved} saved, ${m.allocated_kg} kg, violations ${m.violations}`);
process.exit(run.planner_mode === 'gemini' ? 0 : 1);
