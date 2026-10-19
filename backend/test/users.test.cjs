/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PasswordService } = require('../dist/modules/users/password.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { DatabaseService } = require('../dist/database/database.service');

test('password hashing uses unique salts and verifies only the correct password', async () => {
  const service = new PasswordService();
  const password = 'a sufficiently long password';
  const first = await service.hashPassword(password);
  const second = await service.hashPassword(password);
  assert.match(first, /^\$argon2id\$/);
  assert.notEqual(first, second);
  assert(!first.includes(password));
  assert.equal(await service.verifyPassword(password, first), true);
  assert.equal(
    await service.verifyPassword('incorrect password', first),
    false,
  );
  assert.equal(await service.verifyPassword(password, 'plaintext'), false);
  assert.equal(
    await service.verifyPassword(password, '$argon2id$malformed'),
    false,
  );
  assert.equal(await service.verifyPassword(password, 'scrypt$legacy'), false);
  assert.equal(await service.verifyPassword('x'.repeat(1025), first), false);
  await assert.rejects(service.hashPassword('short'));
  await assert.rejects(service.hashPassword('x'.repeat(1025)));
});

test('email lookup normalizes input and uses SQL parameters', async () => {
  const input = "  Alice@example.com' OR 1=1 --  ";
  const repository = new UsersRepository({
    query: async (sql, params) => {
      assert(!sql.includes(input));
      assert(sql.includes('$1'));
      assert.deepEqual(params, [input.trim().toLowerCase()]);
      return { rows: [] };
    },
  });
  assert.equal(await repository.findCredentialsByEmail(input), null);
});

test('public user lookup does not select password', async () => {
  const repository = new UsersRepository({
    query: async (sql) => {
      assert(!sql.includes('password'));
      return { rows: [] };
    },
  });
  assert.equal(await repository.findById('missing'), null);
});

test('bootstrap lock pins isolation and locks before running work', async () => {
  const calls = [];
  const repository = new UsersRepository({
    transaction: async (work) =>
      work({
        query: async (sql) => calls.push(sql),
      }),
  });
  const result = await repository.withBootstrapLock(async () => {
    calls.push('work');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'SELECT pg_advisory_xact_lock(742019, 2)',
    'LOCK TABLE public."User" IN SHARE ROW EXCLUSIVE MODE',
    'work',
  ]);
});

test('hasAdmin includes disabled administrators and binds the ADMIN role', async () => {
  const repository = new UsersRepository({});
  assert.equal(
    await repository.hasAdmin({
      query: async (sql, values) => {
        assert(!sql.includes('status'));
        assert.deepEqual(values, ['ADMIN']);
        return { rowCount: 1 };
      },
    }),
    true,
  );
});

for (const fails of [false, true]) {
  test(`transaction ${fails ? 'rolls back failure' : 'commits success'} and releases client`, async () => {
    const calls = [];
    const service = new DatabaseService({
      get: (key) => (key === 'DATABASE_URL' ? 'mock-connection' : undefined),
    });
    service.pool = {
      connect: async () => ({
        query: async (sql) => calls.push(sql),
        release: () => calls.push('release'),
      }),
    };
    const action = () =>
      service.transaction(async () => {
        if (fails) throw new Error('business failure');
        return 42;
      });
    if (fails) await assert.rejects(action, /business failure/);
    else assert.equal(await action(), 42);
    assert.deepEqual(calls, [
      'BEGIN',
      fails ? 'ROLLBACK' : 'COMMIT',
      'release',
    ]);
  });
}
