import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { pool } from './db.js'

// Resolved relative to this module, so it lands on server/migrations whether
// we're running from src/ under tsx or from dist/ after a build.
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))

async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations'
  )
  const applied = new Set(rows.map((row) => row.filename))

  const pending = files.filter((name) => !applied.has(name))
  if (pending.length === 0) {
    console.log('No pending migrations.')
    return
  }

  for (const filename of pending) {
    const sql = await readFile(`${migrationsDir}/${filename}`, 'utf8')
    const client = await pool.connect()
    try {
      // The DDL and its bookkeeping row commit together, so a migration can
      // never end up half-applied or applied-but-unrecorded.
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
        filename,
      ])
      await client.query('COMMIT')
      console.log(`applied ${filename}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`migration ${filename} failed: ${String(err)}`)
    } finally {
      client.release()
    }
  }
}

try {
  await migrate()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await pool.end()
}
