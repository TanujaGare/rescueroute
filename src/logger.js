/**
 * Minimal structured JSON logger. Callers pass explicit fields only; request
 * bodies, tokens and passwords are never logged.
 */
export function createLogger({ silent = false } = {}) {
  const write = (level, msg, fields = {}) => {
    if (silent) return;
    // 'severity' and 'message' are the field names Google Cloud Logging parses on Cloud Run.
    const line = JSON.stringify({ time: new Date().toISOString(), severity: level.toUpperCase(), message: msg, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
