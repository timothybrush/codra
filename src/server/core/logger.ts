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

function redact(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') {
    if (typeof obj === 'string') {
      // Redact strings that look like Bearer tokens or JWTs
      if (obj.startsWith('Bearer ') || obj.split('.').length === 3) {
        return '[REDACTED]';
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);

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
    const output = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...store,
      ...this.context,
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
