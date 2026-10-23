import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

/**
 * Error raised for any Gemini failure, classified so the orchestrator can
 * decide whether to retry and can show the coordinator a useful reason.
 * Messages never include the API key or raw provider payloads.
 */
export class PlannerError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const MESSAGES = {
  MISSING_API_KEY: 'GEMINI_API_KEY is not configured on the server.',
  INVALID_API_KEY: 'Gemini rejected the API key. Check GEMINI_API_KEY in .env.',
  UNAUTHORIZED: 'The API key is not permitted to use this model or the Gemini API is not enabled for its project.',
  MODEL_NOT_FOUND: 'The configured GEMINI_MODEL does not exist or is no longer available.',
  RATE_LIMITED: 'Gemini rate limit or quota exceeded.',
  TIMEOUT: 'Gemini did not respond within the time limit.',
  UNAVAILABLE: 'Gemini service is temporarily unavailable.',
  NETWORK: 'Could not reach the Gemini API (network error).',
  BAD_REQUEST: 'Gemini rejected the request.',
  MALFORMED_RESPONSE: 'Gemini returned a response that failed schema validation.',
  UNKNOWN: 'Unexpected Gemini error.',
};

export function plannerError(code, extra) {
  const retryable = ['RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE', 'NETWORK', 'MALFORMED_RESPONSE'].includes(code);
  return new PlannerError(code, extra ? `${MESSAGES[code]} ${extra}` : MESSAGES[code], { retryable });
}

/** Maps SDK / HTTP errors to a PlannerError. Exported for tests. */
export function classifyGeminiError(err) {
  if (err instanceof PlannerError) return err;
  const status = Number(err?.status ?? err?.code);
  const text = String(err?.message ?? '');
  let code = 'UNKNOWN';
  if (err?.name === 'AbortError' || /timed out|aborted/i.test(text)) code = 'TIMEOUT';
  else if (/api key not valid|API_KEY_INVALID|invalid api key/i.test(text)) code = 'INVALID_API_KEY';
  else if (status === 401 || status === 403) code = 'UNAUTHORIZED';
  else if (status === 404) code = 'MODEL_NOT_FOUND';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status >= 500 && status < 600) code = 'UNAVAILABLE';
  else if (status === 400) code = 'BAD_REQUEST';
  else if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(text)) code = 'NETWORK';
  const e = plannerError(code);
  e.status = Number.isFinite(status) ? status : undefined;
  return e;
}

/**
 * Thin adapter over the Gemini API. The orchestrator depends only on the
 * `generate` contract, which keeps the agent loop testable with fake models.
 */
export function createGeminiModel({ apiKey, model, fallbackModels = [], client: injected }) {
  if (!apiKey) return null;
  const client = injected ?? new GoogleGenAI({ apiKey });
  const models = [model, ...fallbackModels.filter((m) => m && m !== model)];
  let active = 0;

  async function call(request) {
    try {
      return await client.models.generateContent(request);
    } catch (err) {
      throw classifyGeminiError(err);
    }
  }

  /** Calls the active model; on overload, quota or missing-model errors, fails over to the next configured model. */
  async function callWithFailover(build, onSwitch) {
    for (;;) {
      try {
        return { response: await call(build(models[active])), model: models[active] };
      } catch (err) {
        const canSwitch = ['UNAVAILABLE', 'RATE_LIMITED', 'MODEL_NOT_FOUND'].includes(err.code) && active < models.length - 1;
        if (!canSwitch) throw err;
        onSwitch?.({ from: models[active], to: models[active + 1], reason: err.code });
        active += 1;
      }
    }
  }

  return {
    get name() {
      return models[active];
    },
    models,

    /** Each run starts again with the primary model. */
    reset() {
      active = 0;
    },

    async generate({ systemInstruction, contents, tools, signal, onSwitch }) {
      const { response, model: used } = await callWithFailover((m) => ({
        model: m,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2,
          tools: [{ functionDeclarations: tools }],
          // Force tool use: the agent may only act through declared tools and ends via `finish`.
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
          abortSignal: signal,
        },
      }), onSwitch);
      return {
        model: used,
        content: response.candidates?.[0]?.content ?? null,
        functionCalls: response.functionCalls ?? [],
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },

    /** Minimal live request used to prove the key and model work. Sends no application data. */
    async ping({ signal }) {
      const { response, model: used } = await callWithFailover((m) => ({
        model: m,
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
        config: { temperature: 0, maxOutputTokens: 64, abortSignal: signal },
      }));
      return { model: used, text: String(response.text ?? '').trim().slice(0, 40) };
    },
  };
}
