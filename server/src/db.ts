import pg from 'pg'

// One pool for the whole process. Connection details come from the standard
// PG* env vars, which node-postgres reads on its own.
export const pool = new pg.Pool({
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

export type DbStatus = {
  database: string
  serverTime: Date
}

export async function pingDatabase(): Promise<DbStatus> {
  const { rows } = await pool.query<{ database: string; server_time: Date }>(
    'SELECT current_database() AS database, now() AS server_time'
  )
  const row = rows[0]
  if (!row) throw new Error('database ping returned no rows')
  return { database: row.database, serverTime: row.server_time }
}
