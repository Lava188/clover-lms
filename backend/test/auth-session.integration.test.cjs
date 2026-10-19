/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { DatabaseService } = require('../dist/database/database.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { UsersService } = require('../dist/modules/users/users.service');
const { PasswordService } = require('../dist/modules/users/password.service');
const {
  AuthSessionRepository,
} = require('../dist/modules/auth/auth-session.repository');
const { AuthService } = require('../dist/modules/auth/auth.service');
const { validateEnvironment } = require('../dist/config/environment');

const connectionString = process.env.AUTH_TEST_DATABASE_URL;
test(
  'PostgreSQL session migration, rotation and revocation integration',
  { skip: !connectionString },
  async (t) => {
    const target = new URL(connectionString);
    assert.equal(
      target.search,
      '',
      'Connection-string overrides are not allowed in integration tests',
    );
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
    assert.equal(
      target.pathname,
      '/clover_auth_test',
      'Only a disposable local clover_auth_test database is allowed',
    );
    const pool = new Pool({ connectionString });
    const database = new DatabaseService({
      get: (key) => (key === 'DATABASE_URL' ? connectionString : undefined),
    });
    const config = validateEnvironment({
      JWT_ACCESS_SECRET: randomBytes(48).toString('base64'),
    });
    const jwt = new JwtService({
      secret: config.JWT_ACCESS_SECRET,
      signOptions: {
        algorithm: 'HS256',
        expiresIn: 900,
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
    });
    const passwords = new PasswordService();
    const users = new UsersRepository(database);
    const usersService = new UsersService(users, passwords);
    const sessions = new AuthSessionRepository(database);
    const auth = new AuthService(
      users,
      passwords,
      jwt,
      new ConfigService(config),
      sessions,
    );
    const password = 'local session test password';
    const login = () => auth.login('admin@example.test', password, 'student');
    const counts = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM "AuthSession"')).rows[0]
        .n;
    const rejects401 = (promise) =>
      assert.rejects(promise, (e) => e.getStatus() === 401);
    try {
      // All migrations execute on a fresh local cluster, never on DATABASE_URL/Neon.
      const migrations = path.resolve(__dirname, '../migrations');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const name of (await readdir(migrations))
          .filter((n) => /^\d+_.+\.sql$/.test(n))
          .sort())
          await client.query(
            await readFile(path.join(migrations, name), 'utf8'),
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await auth.onModuleInit();
      const user = await usersService.createUser({
        fullName: 'Test Admin',
        email: 'admin@example.test',
        password,
        role: 'ADMIN',
      });

      await t.test(
        'login persists only digests and failed credentials create no session',
        async () => {
          const result = await login();
          assert.equal(await counts(), 1);
          const records = (await pool.query('SELECT * FROM "AuthRefreshToken"'))
            .rows;
          assert.equal(records.length, 1);
          assert.equal(
            records[0].hash,
            createHash('sha256').update(result.refreshToken).digest('hex'),
          );
          assert(!JSON.stringify(records).includes(result.refreshToken));
          assert(!JSON.stringify(result.body).includes(result.refreshToken));
          await rejects401(
            auth.login('admin@example.test', 'wrong', 'student'),
          );
          assert.equal(await counts(), 1);
        },
      );

      await t.test(
        'refresh atomically consumes the previous token and preserves absolute expiry',
        async () => {
          const a = await login();
          const b = await auth.refresh(a.refreshToken, 'student');
          assert.notEqual(a.refreshToken, b.refreshToken);
          assert.equal(a.expiresAt.getTime(), b.expiresAt.getTime());
          const sid = jwt.decode(a.body.accessToken).sid;
          const rows = (
            await pool.query(
              'SELECT "consumedAt" FROM "AuthRefreshToken" WHERE "sessionId"=$1',
              [sid],
            )
          ).rows;
          assert.equal(rows.length, 2);
          assert.equal(rows.filter((r) => r.consumedAt === null).length, 1);
          assert.equal(
            (await auth.authenticate(b.body.accessToken)).id,
            user.id,
          );
        },
      );

      await t.test(
        'reuse commits family revocation, including descendant JWT, without revoking another login',
        async () => {
          const a = await login();
          const independent = await login();
          const b = await auth.refresh(a.refreshToken, 'student');
          await rejects401(auth.refresh(a.refreshToken, 'student'));
          await rejects401(auth.refresh(b.refreshToken, 'student'));
          await rejects401(auth.authenticate(b.body.accessToken));
          assert.equal(
            (await auth.authenticate(independent.body.accessToken)).id,
            user.id,
          );
          const sid = jwt.decode(a.body.accessToken).sid;
          assert(
            (
              await pool.query(
                'SELECT "revokedAt" FROM "AuthSession" WHERE id=$1',
                [sid],
              )
            ).rows[0].revokedAt,
          );
        },
      );

      await t.test(
        'two PostgreSQL transactions cannot both rotate one refresh token',
        async () => {
          const a = await login();
          const independent = await login();
          const results = await Promise.allSettled([
            auth.refresh(a.refreshToken, 'student'),
            auth.refresh(a.refreshToken, 'student'),
          ]);
          assert.equal(
            results.filter((r) => r.status === 'fulfilled').length,
            1,
          );
          const failure = results.find((r) => r.status === 'rejected');
          assert.equal(failure.reason.getStatus(), 401);
          // Strict replay policy treats the losing race as reuse and revokes this family.
          const winner = results.find((r) => r.status === 'fulfilled').value;
          await rejects401(auth.refresh(winner.refreshToken, 'student'));
          await rejects401(auth.authenticate(winner.body.accessToken));
          assert.equal(
            (await auth.authenticate(independent.body.accessToken)).id,
            user.id,
          );
        },
      );

      await t.test(
        'JWT signing failures roll back session creation and rotation',
        async () => {
          const existing = await login();
          const before = await counts();
          const original = jwt.signAsync.bind(jwt);
          jwt.signAsync = async () => {
            throw new Error('simulated signing failure');
          };
          try {
            await assert.rejects(login(), (e) => e.getStatus() === 503);
            assert.equal(await counts(), before);
            await assert.rejects(
              auth.refresh(existing.refreshToken, 'student'),
              (e) => e.getStatus() === 503,
            );
          } finally {
            jwt.signAsync = original;
          }
          assert(await auth.refresh(existing.refreshToken, 'student'));
        },
      );

      await t.test(
        'expired, revoked and inactive sessions are denied',
        async () => {
          for (const state of ['expired', 'revoked', 'inactive']) {
            const a = await login();
            const sid = jwt.decode(a.body.accessToken).sid;
            if (state === 'expired')
              await pool.query(
                `UPDATE "AuthSession" SET "createdAt"=now()-interval '2 days', "expiresAt"=now()-interval '1 day' WHERE id=$1`,
                [sid],
              );
            if (state === 'revoked')
              await pool.query(
                'UPDATE "AuthSession" SET "revokedAt"=now() WHERE id=$1',
                [sid],
              );
            if (state === 'inactive')
              await pool.query('UPDATE "User" SET status=false WHERE id=$1', [
                user.id,
              ]);
            await rejects401(auth.refresh(a.refreshToken, 'student'));
            await rejects401(auth.authenticate(a.body.accessToken));
            await pool.query('UPDATE "User" SET status=true WHERE id=$1', [
              user.id,
            ]);
          }
        },
      );

      await t.test(
        'logout is idempotent and revokes current session only, including with consumed token',
        async () => {
          const a = await login();
          const b = await auth.refresh(a.refreshToken, 'student');
          const independent = await login();
          await auth.logout(a.refreshToken, 'student');
          await auth.logout(a.refreshToken, 'student');
          await auth.logout(undefined, 'student');
          await auth.logout('malformed', 'student');
          await rejects401(auth.refresh(b.refreshToken, 'student'));
          await rejects401(auth.authenticate(b.body.accessToken));
          assert.equal(
            (await auth.authenticate(independent.body.accessToken)).id,
            user.id,
          );
        },
      );

      await t.test(
        'client mismatch cannot refresh or revoke a CMS session',
        async () => {
          const a = await auth.login('admin@example.test', password, 'admin');
          await rejects401(auth.refresh(a.refreshToken, 'student'));
          await auth.logout(a.refreshToken, 'student');
          assert(await auth.refresh(a.refreshToken, 'admin'));
        },
      );

      await t.test(
        'deleted User cascades sessions and tokens; old access and refresh tokens fail',
        async () => {
          const a = await login();
          const sid = jwt.decode(a.body.accessToken).sid;
          await pool.query('DELETE FROM "User" WHERE id=$1', [user.id]);
          await rejects401(auth.refresh(a.refreshToken, 'student'));
          await rejects401(auth.authenticate(a.body.accessToken));
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM "AuthRefreshToken" WHERE "sessionId"=$1',
                [sid],
              )
            ).rows[0].n,
            0,
          );
        },
      );
    } finally {
      await database.onModuleDestroy();
      await pool.end();
    }
  },
);
