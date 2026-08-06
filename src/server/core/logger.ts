import { AsyncLocalStorage } from 'node:async_hooks';

const SENSITIVE_KEYS = [
  'api_key',
  'api-key',
  'apikey',
  'secret',
  'password',
  'token',
  'private_key',
  'private-key',
  'database_url',
  'authorization',
  'session',
  'cookie',
];

const storage = new AsyncLocalStorage<Record<string, any>>();

// A JWT: three base64url segments, the first being base64 of `{"...` so it always starts `eyJ`.
// Anchoring on that is what keeps this from matching ordinary prose.
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Scrubs secrets OUT OF a string rather than discarding the whole string.
//
// The previous test was `str.split('.').length === 3`, i.e. "contains exactly two periods". That is
// not a JWT test: it deleted every message that happened to have two dots -- which is exactly the
// shape of "...failed for x/y/z.ts; retrying later. Last error: Vertex AI timed out after 40000ms" --
// while a 429 message (8 dots) and every stack trace (5+ dots) sailed through untouched. So it
// destroyed the diagnostics it hit and protected nothing: the same text survived in `stack`.
function scrubString(value: string): string {
  return value.replace(JWT, '[REDACTED_JWT]').replace(BEARER, (m) => `${m.split(/\s+/)[0]} [REDACTED]`);
}

function redact(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') {
    return typeof obj === 'string' ? scrubString(obj) : obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  // Error instances do not expose name/message/stack as own enumerable properties, so
  // Object.entries() returns [] and they serialize to {}. Normalize first, then scrub.
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: scrubString(obj.message),
      ...(obj.stack ? { stack: scrubString(obj.stack) } : {}),
    };
  }

  const redacted: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sk) => lowerKey.includes(sk))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redact(value);
    }
  }
  return redacted;
}

class Logger {
  constructor(private context: Record<string, any> = {}) {}

  withContext(newContext: Record<string, any>) {
    return new Logger({ ...this.context, ...newContext });
  }

  private log(level: string, message: string, data?: any) {
    const store = storage.getStore() || {};
    // `message` and both context objects go through redaction too. Scrubbing only `data` left three
    // unscrubbed paths to the same log line, which is how a "redacted" field could sit beside the
    // identical text in an unredacted one.
    const output = {
      timestamp: new Date().toISOString(),
      level,
      message: scrubString(message),
      ...redact(store),
      ...redact(this.context),
      ...(data ? { data: redact(data) } : {}),
    };

    if (level === 'error') {
      console.error(JSON.stringify(output));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(output));
    } else {
      console.log(JSON.stringify(output));
    }
  }

  runWithContext<T>(context: Record<string, any>, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...context }, fn);
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  error(message: string, data?: any) {
    if (data instanceof Error) {
      this.log('error', message, {
        name: data.name,
        message: data.message,
        stack: data.stack,
      });
    } else {
      this.log('error', message, data);
    }
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }
}

export const logger = new Logger();
