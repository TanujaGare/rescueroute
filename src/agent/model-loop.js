import { executeTool, functionDeclarations } from './tools.js';
import { classifyGeminiError, plannerError } from './gemini.js';
import { SYSTEM_POLICY, initialPrompt } from './policy.js';
import { safeError, sleep, truncateForTrace } from '../lib/util.js';

const MAX_CALLS_PER_TURN = 25;
const MAX_NON_TOOL_TURNS = 2;
const FAST_RETRY_BASE_MS = 400;

/** Counters shared by the model loop and the run report. */
export function newModelMetrics() {
  return {
    model_calls: 0,
    model_successes: 0,
    model_retries: 0,
    model_switches: [],
    models_used: [],
    tool_calls: 0,
    tool_errors: 0,
    blocked_tool_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
}

/**
 * Bounded Gemini tool-calling loop. Stops on `finish`, on any budget
 * (turns, tool calls, run time) or on a non-retryable model error.
 */
export function createModelLoop({ model, config, clock }) {
  async function callWithRetry(contents, tools, metrics, started) {
    let lastErr;
    for (let attempt = 0; attempt <= config.agent.modelRetries; attempt++) {
      if (attempt > 0) {
        metrics.model_retries += 1;
        // Rate limits need a real pause (free-tier quotas are per minute); other errors retry quickly.
        const base = lastErr?.code === 'RATE_LIMITED' ? config.agent.rateLimitBackoffMs : FAST_RETRY_BASE_MS;
        const remaining = Math.max(0, config.agent.runBudgetMs - (clock() - started));
        await sleep(Math.min(base * 2 ** (attempt - 1), remaining));
      }
      metrics.model_calls += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.agent.modelTimeoutMs);
      try {
        const raw = await Promise.race([
          model.generate({
            systemInstruction: SYSTEM_POLICY,
            contents,
            tools,
            signal: controller.signal,
            onSwitch: (sw) => metrics.model_switches.push(sw),
          }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(plannerError('TIMEOUT')))),
        ]);
        const response = normaliseResponse(raw);
        metrics.model_successes += 1;
        if (response.model && !metrics.models_used.includes(response.model)) metrics.models_used.push(response.model);
        return response;
      } catch (err) {
        lastErr = classifyGeminiError(err);
        // Bad keys, missing models and rejected requests will not succeed on retry.
        if (!lastErr.retryable) throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  function runTool(state, call, metrics, outcome, trace) {
    metrics.tool_calls += 1;
    const startedAt = clock();
    let result;
    try {
      result = executeTool(state, call.name, call.args);
    } catch (err) {
      result = { ok: false, output: { error: 'TOOL_FAILED', message: safeError(err) } };
    }
    if (!result.ok) metrics.tool_errors += 1;
    if (result.securityEvent) metrics.blocked_tool_calls += 1;
    if (call.name === 'propose_dispatch') recordProposal(outcome, call, result);
    if (call.name === 'finish' && result.ok) {
      outcome.finished = true;
      outcome.summary = result.args.summary;
    }
    trace({
      kind: result.securityEvent ? 'blocked' : 'tool_call',
      tool: String(call.name).slice(0, 60),
      ok: result.ok,
      latency_ms: clock() - startedAt,
      input: result.args ?? truncateForTrace(call.args),
      output: compactOutput(call.name, result.output),
    });
    return { functionResponse: { id: call.id, name: call.name, response: { result: result.output } } };
  }

  /** Runs the loop and returns { finished, error, summary, proposed, rejected }. */
  return async function runModelLoop({ state, objective, trace, metrics, started, baselinePlan }) {
    const outcome = { finished: false, error: null, summary: null, proposed: 0, rejected: [] };
    const tools = functionDeclarations();
    const contents = [{ role: 'user', parts: [{ text: initialPrompt({ objective, state, baselinePlan }) }] }];
    let nonToolTurns = 0;

    for (let turn = 1; turn <= config.agent.maxModelTurns; turn++) {
      if (clock() - started > config.agent.runBudgetMs) {
        outcome.error = plannerError('TIMEOUT', 'Run time budget exhausted.');
        return outcome;
      }
      const turnStarted = clock();
      let response;
      try {
        response = await callWithRetry(contents, tools, metrics, started);
      } catch (err) {
        const e = classifyGeminiError(err);
        trace({ kind: 'model', ok: false, latency_ms: clock() - turnStarted, output: { turn, error_code: e.code, error: e.message } });
        outcome.error = e;
        return outcome;
      }
      metrics.input_tokens += response.usage.inputTokens;
      metrics.output_tokens += response.usage.outputTokens;
      const calls = response.functionCalls.slice(0, MAX_CALLS_PER_TURN);
      trace({
        kind: 'model',
        ok: calls.length > 0,
        latency_ms: clock() - turnStarted,
        output: { turn, requested_tools: calls.map((c) => c.name), tokens: response.usage },
      });

      if (calls.length === 0 || !response.content) {
        nonToolTurns += 1;
        if (nonToolTurns >= MAX_NON_TOOL_TURNS) {
          outcome.error = plannerError('MALFORMED_RESPONSE', 'No valid tool calls returned.');
          return outcome;
        }
        contents.push({ role: 'user', parts: [{ text: 'Respond only with tool calls as instructed.' }] });
        continue;
      }
      contents.push(response.content);

      const replies = [];
      for (const call of calls) {
        if (metrics.tool_calls >= config.agent.maxToolCalls) {
          outcome.error = plannerError('TIMEOUT', 'Tool-call budget exhausted.');
          return outcome;
        }
        replies.push(runTool(state, call, metrics, outcome, trace));
      }
      contents.push({ role: 'user', parts: replies });
      if (outcome.finished) return outcome;
    }
    outcome.error = plannerError('TIMEOUT', 'Model turn limit reached before finish.');
    return outcome;
  };
}

function recordProposal(outcome, call, result) {
  if (result.ok) {
    outcome.proposed += 1;
    return;
  }
  const fallbackViolation = { code: result.output.error, message: (result.output.issues ?? []).join('; ') };
  outcome.rejected.push({
    donation_id: result.args?.donation_id ?? String(call.args?.donation_id ?? '?').slice(0, 64),
    violations: result.output.violations ?? [fallbackViolation],
  });
}

function normaliseResponse(raw) {
  if (!raw || typeof raw !== 'object') throw plannerError('MALFORMED_RESPONSE');
  const functionCalls = Array.isArray(raw.functionCalls)
    ? raw.functionCalls.filter((c) => c && typeof c.name === 'string')
    : [];
  return {
    model: typeof raw.model === 'string' ? raw.model : null,
    content: raw.content ?? null,
    functionCalls,
    usage: { inputTokens: raw.usage?.inputTokens ?? 0, outputTokens: raw.usage?.outputTokens ?? 0 },
  };
}

const LISTING_TOOLS = { list_open_donations: 'donations', list_recipients: 'recipients', list_vehicles: 'vehicles' };

/** Listing outputs are large; the trace records a count rather than the full payload. */
function compactOutput(name, output) {
  const key = LISTING_TOOLS[name];
  return key && output?.[key] ? { count: output[key].length } : output;
}
