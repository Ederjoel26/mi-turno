import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({
  connectionString: env.databaseUrl
});

export async function checkDbConnection(): Promise<string> {
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0]?.now?.toISOString?.() ?? String(result.rows[0]?.now);
}
