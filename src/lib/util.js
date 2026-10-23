/** Small shared helpers with no domain knowledge. */

const SECRET_PATTERNS = [
  [/key=[^&\s]+/gi, 'key=[redacted]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],
  [/AQ\.[0-9A-Za-z_-]{20,}/g, '[redacted]'],
];
const MAX_ERROR_LENGTH = 240;
const MAX_TRACE_JSON = 500;

/** Error message that is safe to store, log or show: secrets redacted, length bounded. */
export function safeError(err) {
  let text = String(err?.message ?? err);
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/** Bounds untrusted values before they are written to the trace. */
export function truncateForTrace(value) {
  try {
    const json = JSON.stringify(value ?? null);
    return json.length > MAX_TRACE_JSON ? { truncated: json.slice(0, MAX_TRACE_JSON) } : value;
  } catch {
    return null;
  }
}

export const iso = (ms) => new Date(ms).toISOString();
export const round1 = (n) => Math.round(n * 10) / 10;
export const round3 = (n) => Math.round(n * 1000) / 1000;
export const sumKg = (items) => round1(items.reduce((total, item) => total + item.quantity_kg, 0));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
