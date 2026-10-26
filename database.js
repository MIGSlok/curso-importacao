import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  totp_secret TEXT, totp_pending TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  pending_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), course_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL,
  preference_id TEXT, payment_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS orders_user_course ON orders(user_id, course_id);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at BIGINT NOT NULL
);
`;

export async function openDatabase(root) {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
    await pool.query(schema);
    return {
      prepare(sql) {
        let parameter = 0;
        const statement = sql.replace(/\?/g, () => `$${++parameter}`);
        return {
          async get(...values) { return (await pool.query(statement, values)).rows[0]; },
          async all(...values) { return (await pool.query(statement, values)).rows; },
          async run(...values) { const result = await pool.query(statement, values); return { changes: result.rowCount }; }
        };
      }
    };
  }
  if (process.env.VERCEL) throw new Error('DATABASE_URL é obrigatória na hospedagem.');
  const dbPath = path.join(root, 'data', 'portal.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });
  await mkdir(path.join(root, 'private'), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(schema);
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        async get(...values) { return statement.get(...values); },
        async all(...values) { return statement.all(...values); },
        async run(...values) { return statement.run(...values); }
      };
    }
  };
}
