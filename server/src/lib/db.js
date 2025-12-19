import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: typeof process.env.PGPASSWORD === "string" ? process.env.PGPASSWORD : undefined,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,  
  max: 10,
  // Fail fast instead of hanging the request when Postgres is unreachable
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

export async function ensureSchema() {
  const sqlDir = path.join(__dirname, "../../sql");
  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const file of files) {
      const query = fs.readFileSync(path.join(sqlDir, file), "utf8");
      await client.query(query);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export const sql = {
  async one(query, params = []) {
    const r = await pool.query(query, params);
    if (!r.rows[0]) throw new Error("Expected one row, got zero");
    return r.rows[0];
  },
  async oneOrNone(query, params = []) {
    const r = await pool.query(query, params);
    return r.rows[0] || null;
  },
  async many(query, params = []) {
    const r = await pool.query(query, params);
    return r.rows;
  },
  async exec(query, params = []) {
    await pool.query(query, params);
  },
};
