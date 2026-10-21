// Structured JSON logs to stdout. Refuses secrets by field name (CLAUDE.md:
// tokens, OTPs, cookies and vendor sessions are never logged): outside
// production a denied field throws so the mistake is caught in development;
// in production the value is replaced rather than written.
import { LOG_DENIED_FIELDS } from './constants.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DENIED = new Set(LOG_DENIED_FIELDS);

export class LogSafetyError extends Error {}

function scrub(value: unknown, strict: boolean, path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, strict, `${path}[${i}]`));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Fields = {};
    for (const [k, v] of Object.entries(value as Fields)) {
      if (DENIED.has(k.toLowerCase())) {
        if (strict) throw new LogSafetyError(`refusing to log field "${path}${k}"`);
        out[k] = '[refused]';
      } else {
        out[k] = scrub(v, strict, `${path}${k}.`);
      }
    }
    return out;
  }
  return value;
}

// `write` replaces stdout/stderr — tests use it to assert what was (not) logged.
export function createLogger(
  opts: { level?: Level; production?: boolean; service?: string; write?: (line: string) => void } = {},
): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const strict = !opts.production;
  const emit = (level: Level, msg: string, fields?: Fields) => {
    if (ORDER[level] < min) return;
    const safe = fields ? (scrub(fields, strict, '') as Fields) : {};
    const line = JSON.stringify({ t: new Date().toISOString(), level, service: opts.service, msg, ...safe });
    if (opts.write) opts.write(line);
    else (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

// An error's name and message only — never its cause chain or attached
// request, which can carry headers or bodies with credentials in them.
export function errorFields(err: unknown): Fields {
  if (err instanceof Error) return { error: err.name, detail: err.message };
  return { error: String(err) };
}
