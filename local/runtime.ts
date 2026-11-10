/** Storage contract shared by the local runtime and isolated tests. */
type Awaitable<T> = T | Promise<T>;
export interface QueryResult {
  results?: unknown[];
  success?: boolean;
  meta?: { changes?: number };
}
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Awaitable<T | null>;
  all(): Awaitable<QueryResult>;
  run(): Awaitable<QueryResult>;
}
export interface Runtime {
  DB: {
    prepare(sql: string): Statement;
    batch(statements: Statement[]): Awaitable<QueryResult[]>;
  };
  // Provider, local settings and file adapters are configured at startup.
  [key: string]: any;
}
let current: Runtime | undefined;
export function setRuntime(value: Runtime) {
  current = value;
}
export function getRuntime(): Runtime {
  if (!current) throw new Error("Local runtime has not been initialized.");
  return current;
}
