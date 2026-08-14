import type { DbEnv } from './env';
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';

type DbClient = {
  query<T>(sqlText: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
};

const dbStorage = new AsyncLocalStorage<DbClient>();

function createDbClient(env: DbEnv): DbClient {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
  });

  return {
    async query<T>(sqlText: string, params: unknown[] = []) {
      return (await sql.unsafe(sqlText, params.map(normalizeParam) as any[], { prepare: false })) as T[];
    },
    async transaction<T>(fn: (tx: DbClient) => Promise<T>) {
      return (await sql.begin(async (t) => {
        const txClient: DbClient = {
          async query<U>(sqlText: string, params: unknown[] = []) {
            return (await t.unsafe(sqlText, params.map(normalizeParam) as any[], { prepare: false })) as U[];
          },
          async transaction<U>(innerFn: (tx: DbClient) => Promise<U>) {
            // Nested transactions could use savepoints, but for now we just reuse the same txClient
            return await innerFn(txClient);
          }
        };
        return await fn(txClient);
      })) as T;
    }
  };
}

// WRITING JSONB: bind JSON.stringify(value) and cast the placeholder $n::text::jsonb, not $n::jsonb -- postgres.js otherwise stores a jsonb STRING SCALAR, and JSON operators see nothing.
function normalizeParam(param: unknown): unknown {
  return Array.isArray(param) ? toPostgresArrayLiteral(param) : param;
}

function toPostgresArrayLiteral(values: unknown[]) {
  return `{${values.map(toPostgresArrayElement).join(',')}}`;
}

function toPostgresArrayElement(value: unknown) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const text = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  return `"${text}"`;
}

export function runWithDb<T>(env: DbEnv, fn: () => T): T {
  return dbStorage.run(createDbClient(env), fn);
}

// Keyed by connection string so a caller outside a runWithDb() scope shares one bounded pool instead of leaking a fresh pool per query.
//
// This Map lives at MODULE SCOPE, which in Workers outlives the request that filled it -- so a cached
// client holds a socket opened in an earlier request context, and the next request to reuse it dies with
// "Cannot perform I/O on behalf of a different request". It was described as test-only ("production
// always wraps work in runWithDb()"), but production hit it repeatedly: binding a workflow ID to a job,
// recovering expired job leases, and at least one outright failed file review. AsyncLocalStorage context
// can also be lost crossing into a Workflow/jsrpc entrypoint, which drops callers onto this path without
// them changing anything. So the cache has to be self-healing rather than merely convenient.
const fallbackClients = new Map<string, DbClient>();

// Both faces of a socket belonging to a dead request context: the runtime's refusal, and a pooled
// connection that was already torn down with it.
function isStaleConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Cannot perform I/O on behalf of a different request')
    || message.includes('CONNECTION_CLOSED');
}

export function getDb(env: DbEnv) {
  const store = dbStorage.getStore();
  if (store) return store;

  const connectionString = env.HYPERDRIVE.connectionString;
  let client = fallbackClients.get(connectionString);
  if (!client) {
    client = createDbClient(env);
    fallbackClients.set(connectionString, client);
  }
  return client;
}

// Runs `op` against the ambient client, and if a request-scoped socket from the module cache has gone
// stale, discards it and retries ONCE on a fresh one. Only the cached path is retried: inside
// runWithDb() the client belongs to this request already, so the same error there is a real bug and must
// surface rather than be papered over.
async function withStaleConnectionRecovery<T>(env: DbEnv, op: (db: DbClient) => Promise<T>): Promise<T> {
  const inScope = dbStorage.getStore() !== undefined;
  try {
    return await op(getDb(env));
  } catch (error) {
    if (env.workerMode === false || inScope || !isStaleConnectionError(error)) throw error;

    const connectionString = env.HYPERDRIVE.connectionString;
    fallbackClients.delete(connectionString);
    const fresh = createDbClient(env);
    fallbackClients.set(connectionString, fresh);
    return op(fresh);
  }
}

export async function queryRows<T>(env: DbEnv, sqlText: string, params: unknown[] = []) {
  return withStaleConnectionRecovery(env, (db) => db.query<T>(sqlText, params));
}

export async function queryTransaction<T>(env: DbEnv, fn: (tx: DbClient) => Promise<T>) {
  // Safe to re-run: the failed attempt never reached the server, so no partial transaction was committed.
  return withStaleConnectionRecovery(env, (db) => db.transaction<T>(fn));
}

export function parseJsonColumn<T>(value: T | string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value;
}
