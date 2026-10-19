import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing from backend/.env.');
  }

  const directory = path.resolve(import.meta.dirname, '../migrations');
  const files = (await readdir(directory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    // Transaction-level lock also works with transaction-pooled connections.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(742019, 1)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const { rows: columns } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    `);
    // Support the history table created by earlier migration tooling.
    const filenameColumn = columns.some(
      (column) => column.column_name === 'filename',
    )
      ? 'filename'
      : 'file_name';
    const { rows } = await client.query(
      `SELECT "${filenameColumn}" AS filename, checksum FROM public.schema_migrations`,
    );
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));
    for (const filename of applied.keys()) {
      if (!files.includes(filename)) {
        throw new Error(`Applied migration file is missing: ${filename}`);
      }
    }

    const pending = [];
    for (const filename of files) {
      const source = await readFile(path.join(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      if (applied.has(filename)) {
        if (applied.get(filename) !== checksum) {
          throw new Error(
            `Migration was modified after being applied: ${filename}`,
          );
        }
        continue;
      }
      // Existing bootstrap wraps its entire body in BEGIN/COMMIT.
      // The runner owns the transaction so history and DDL commit together.
      const sql = source.replace(
        /^(\s*(?:--[^\n]*\n\s*)*)BEGIN\s*;([\s\S]*)COMMIT\s*;\s*$/i,
        '$1$2',
      );
      console.log(`Applying migration: ${filename}`);
      await client.query(sql);
      await client.query(
        `INSERT INTO public.schema_migrations ("${filenameColumn}", checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
      pending.push(filename);
    }
    await client.query('COMMIT');
    console.log(
      pending.length
        ? `Successfully applied ${pending.length} migration(s).`
        : 'Database is up to date. No pending migrations.',
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  // Avoid printing database errors which may contain credentials or SQL data.
  console.error(
    'Migration failed. Rollback was attempted if a transaction had started. Check DATABASE_URL, connectivity, the existing schema, and migration history. Do not modify applied migrations.',
  );
  console.error(`Error code: ${error.code ?? 'MIGRATION_ERROR'}`);
  const messages = {
    42703: 'The migration history table is missing a required column.',
    '42P07':
      'The table already exists. Reconcile the schema and migration history.',
    42710: 'The database object already exists. Reconcile migration history.',
    '28P01': 'Database authentication failed. Check your credentials.',
    42501: 'The database role has insufficient privileges.',
    ENOTFOUND: 'The database hostname could not be resolved.',
    ETIMEDOUT: 'The database connection timed out.',
  };
  if (messages[error.code]) console.error(messages[error.code]);
  if (!error.code) {
    console.error(
      String(error.message)
        .replaceAll(process.env.DATABASE_URL || '\0', '[DATABASE_URL]')
        .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL]'),
    );
  }
  process.exitCode = 1;
});
