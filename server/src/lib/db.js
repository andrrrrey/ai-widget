import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

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
