import pg from 'pg'

// A `date` column is a calendar day: no time, no zone. Left alone, pg parses it
// into a Date at local midnight, and anything that later reads it in UTC lands
// on the previous day for TZs behind UTC. Hand back the raw 'YYYY-MM-DD' text
// instead, which is exactly what the API contract wants anyway.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value)

// Same story for `time`: left alone, pg parses it into a JS Date pinned to
// 1970-01-01 in local time, which is meaningless for a wall-clock time that
// isn't tied to any date. Hand back the raw 'HH:MM:SS' text instead.
pg.types.setTypeParser(pg.types.builtins.TIME, (value) => value)

// One pool for the whole process. Connection details come from the standard
// PG* env vars, which node-postgres reads on its own.
export const pool = new pg.Pool({
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

/**
 * Runs `fn` inside a single transaction on a dedicated client, committing on
 * return and rolling back on throw. Needed wherever one request writes both
 * employees and employment_details, so a half-written employee can't survive.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

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
