/**
 * sqlite-adapter.ts — wraps better-sqlite3 to expose a D1Database-compatible shape.
 *
 * Used by src/node-entry.ts so all existing app code that receives a D1Database
 * binding (cron handler, pool-resolver, auth config, etc.) works without
 * modification under the Node self-host target.
 *
 * The returned object also carries a `__sqlite` property (the raw better-sqlite3
 * Database instance). client.ts detects this property to route Drizzle queries
 * through drizzle-orm/better-sqlite3 instead of drizzle-orm/d1 — without
 * importing this file (keeping the Workers bundle clean).
 *
 * Coverage:
 *   prepare().bind().run()   ✓  — used by app code, cron, and tests
 *   prepare().bind().all()   ✓
 *   prepare().bind().first() ✓
 *   prepare().bind().raw()   ✓
 *   batch()                  ✓  (sequential; SQLite has no true batch API)
 *   exec()                   ✓  — used by applyMigrations in node-entry.ts
 *   dump()                   stub — not needed for Node self-host v1
 *   withSession()            stub — D1 Sessions API, not needed for Node
 *
 * Note: better-sqlite3 is synchronous; this adapter wraps every result in
 * a resolved Promise so callers can await them identically to real D1.
 */

import type BetterSqlite3 from 'better-sqlite3';

/**
 * D1Database + the raw sqlite instance for the Drizzle adapter picker in
 * client.ts to detect Node mode via the `__sqlite` property.
 */
export interface SqliteAdapterBinding extends D1Database {
  __sqlite: BetterSqlite3.Database;
}

// Shared meta factory — avoids repeating the zero-value object.
function successMeta(changes = 0, lastRowId = 0, rowsRead = 0) {
  return {
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    duration: 0,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: changes,
  };
}

export function wrapSqliteAsD1(sqlite: BetterSqlite3.Database): SqliteAdapterBinding {
  function prepare(sql: string): D1PreparedStatement {
    const stmt = sqlite.prepare(sql);
    let bound: unknown[] = [];

    // Build the wrapper without the D1PreparedStatement annotation to avoid
    // fighting the overloaded `raw()` signature in workers-types. The object
    // implements the full interface; we cast to D1PreparedStatement at the end.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapper: any = {
      bind(...args: unknown[]) {
        bound = args;
        return wrapper as D1PreparedStatement;
      },

      run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        try {
          const r = stmt.run(...bound);
          return Promise.resolve({
            success: true,
            results: [] as T[],
            meta: successMeta(r.changes, Number(r.lastInsertRowid), 0),
          } as D1Result<T>);
        } catch (err) {
          // Cast through unknown: D1Result<T> technically only allows success:true,
          // but we want to surface the error string to callers who check .success.
          return Promise.resolve({
            success: false,
            results: [] as T[],
            error: String(err),
            meta: successMeta(),
          } as unknown as D1Result<T>);
        }
      },

      all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const results = stmt.all(...bound) as T[];
        return Promise.resolve({
          success: true,
          results,
          meta: successMeta(0, 0, results.length),
        } as D1Result<T>);
      },

      first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
        const row = stmt.get(...bound) as Record<string, unknown> | undefined;
        if (row == null) return Promise.resolve(null);
        if (col != null) return Promise.resolve(row[col] as T);
        return Promise.resolve(row as T);
      },

      // D1PreparedStatement.raw has two overloads that cannot both be satisfied
      // without casting; we implement both cases and let the `any` wrapper absorb
      // the overload resolution.
      raw(options?: { columnNames: true }): Promise<unknown[]> {
        const rawStmt = stmt.raw();
        if (options?.columnNames) {
          const rows = rawStmt.all(...bound);
          const cols = stmt.columns().map((c: { name: string }) => c.name);
          return Promise.resolve([cols, ...rows]);
        }
        return Promise.resolve(rawStmt.all(...bound));
      },
    };

    return wrapper as D1PreparedStatement;
  }

  const binding: SqliteAdapterBinding = {
    // Sentinel property — client.ts checks for this to route to better-sqlite3 Drizzle
    __sqlite: sqlite,

    prepare,

    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // SQLite has no native batch; run sequentially.
      return Promise.all(statements.map((s) => s.run<T>()));
    },

    exec(query: string): Promise<D1ExecResult> {
      const t0 = Date.now();
      sqlite.exec(query);
      return Promise.resolve({ count: 1, duration: Date.now() - t0 });
    },

    dump(): Promise<ArrayBuffer> {
      return Promise.reject(
        new Error('SqliteAdapter: dump() is not supported on the Node self-host target'),
      );
    },

    withSession(_token?: string): D1DatabaseSession {
      throw new Error(
        'SqliteAdapter: withSession() is not supported on the Node self-host target',
      );
    },
  };

  return binding;
}
