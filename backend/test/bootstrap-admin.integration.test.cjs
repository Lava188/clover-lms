/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { DatabaseService } = require('../dist/database/database.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { UsersService } = require('../dist/modules/users/users.service');
const { PasswordService } = require('../dist/modules/users/password.service');

const connectionString = process.env.BOOTSTRAP_TEST_DATABASE_URL;

// This suite may initialize and truncate ONLY a disposable loopback database.
// It never reads DATABASE_URL or loads .env to select its target.
test(
  'bootstrap PostgreSQL integration',
  { skip: !connectionString },
  async (t) => {
    const target = new URL(connectionString);
    assert.equal(
      target.search,
      '',
      'Connection-string overrides are not allowed in integration tests',
    );
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
      'Integration tests require a local PostgreSQL server',
    );
    assert.equal(
      target.pathname,
      '/clover_bootstrap_test',
      'Use a dedicated disposable clover_bootstrap_test database',
    );
    const pool = new Pool({ connectionString });
    const database = new DatabaseService({
      get: (key) => (key === 'DATABASE_URL' ? connectionString : undefined),
    });
    const passwords = new PasswordService();
    const service = new UsersService(new UsersRepository(database), passwords);
    const input = {
      fullName: 'Initial Admin',
      email: 'admin@example.test',
      password: 'integration-test-password-123',
    };
    const reset = () => pool.query('TRUNCATE public."User" CASCADE');
    const cli = (email) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve(__dirname, '../scripts/bootstrap-admin.ts')],
          {
            cwd: path.resolve(__dirname, '..'),
            env: {
              ...process.env,
              DATABASE_URL: connectionString,
              CORS_ORIGIN: 'http://localhost:5173',
              BOOTSTRAP_ADMIN_NAME: input.fullName,
              BOOTSTRAP_ADMIN_EMAIL: email,
              BOOTSTRAP_ADMIN_PASSWORD: input.password,
              BOOTSTRAP_ADMIN_PHONE: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.on('data', (data) => {
          output += data;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
    try {
      const migrations = path.resolve(__dirname, '../migrations');
      const files = (await readdir(migrations))
        .filter((f) => /^\d+_.+\.sql$/.test(f))
        .sort();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const file of files)
          await client.query(
            await readFile(path.join(migrations, file), 'utf8'),
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      await t.test(
        'creates the first active ADMIN with Argon2id and nullable phone',
        async () => {
          const user = await service.bootstrapFirstAdmin(input);
          assert.equal(user.role, 'ADMIN');
          assert.equal(user.status, true);
          assert.equal(user.phone, null);
          assert(!Object.hasOwn(user, 'password'));
          const row = (
            await pool.query('SELECT password FROM "User" WHERE id=$1', [
              user.id,
            ])
          ).rows[0];
          assert.equal(
            await passwords.verifyPassword(input.password, row.password),
            true,
          );
        },
      );

      await t.test(
        'an existing disabled ADMIN blocks bootstrap without changing accounts',
        async () => {
          await pool.query('UPDATE "User" SET status=false');
          const before = (await pool.query('SELECT * FROM "User"')).rows;
          await assert.rejects(
            service.bootstrapFirstAdmin({
              ...input,
              email: 'another@example.test',
            }),
            /already exists/,
          );
          assert.deepEqual(
            (await pool.query('SELECT * FROM "User"')).rows,
            before,
          );
        },
      );

      await t.test(
        'duplicate TEACHER/STUDENT email never promotes or overwrites the account',
        async () => {
          for (const role of ['TEACHER', 'STUDENT']) {
            await reset();
            await service.createUser({ ...input, role });
            const before = (await pool.query('SELECT * FROM "User"')).rows;
            await assert.rejects(
              service.bootstrapFirstAdmin({
                ...input,
                email: input.email.toUpperCase(),
              }),
              (error) => error.getStatus() === 409,
            );
            assert.deepEqual(
              (await pool.query('SELECT * FROM "User"')).rows,
              before,
            );
          }
        },
      );

      await t.test('invalid input leaves the account table empty', async () => {
        await reset();
        for (const override of [
          { fullName: '' },
          { email: 'invalid' },
          { password: 'short' },
        ])
          await assert.rejects(
            service.bootstrapFirstAdmin({ ...input, ...override }),
          );
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM "User"')).rows[0].n,
          0,
        );
      });

      await t.test(
        'two simultaneous CLI processes create exactly one first ADMIN',
        async () => {
          await reset();
          const results = await Promise.all([
            cli('first@example.test'),
            cli('second@example.test'),
          ]);
          assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM "User" WHERE role=\'ADMIN\'',
              )
            ).rows[0].n,
            1,
          );
          assert(
            results.some((r) => r.output.includes('created successfully')),
          );
          assert(results.some((r) => r.output.includes('already exists')));
          for (const result of results) {
            assert(!result.output.includes(input.password));
            assert(!result.output.includes('$argon2id$'));
          }
        },
      );
    } finally {
      await database.onModuleDestroy();
      await pool.end();
    }
  },
);
