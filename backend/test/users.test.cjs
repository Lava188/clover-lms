/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PasswordService } = require('../dist/modules/users/password.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { DatabaseService } = require('../dist/database/database.service');

test('password hashing uses unique salts and verifies only the correct password', async () => {
  const service = new PasswordService();
  const password = 'a sufficiently long password';
  const first = await service.hash(password);
  const second = await service.hash(password);
  assert.notEqual(first, second);
  assert(!first.includes(password));
  assert.equal(await service.verify(password, first), true);
  assert.equal(await service.verify('incorrect password', first), false);
  assert.equal(await service.verify(password, 'plaintext'), false);
  assert.equal(await service.verify(password, first.slice(0, -1)), false);
  await assert.rejects(service.hash('short'));
  await assert.rejects(service.hash('x'.repeat(1025)));
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

test('bootstrap refuses an existing admin before inserting', async () => {
  let calls = 0;
  const repository = new UsersRepository({
    transaction: async (work) =>
      work({
        query: async () => {
          calls++;
          return { rowCount: calls === 2 ? 1 : 0 };
        },
      }),
  });
  await assert.rejects(repository.bootstrapAdmin({}), /already exists/);
  assert.equal(calls, 2);
});

test('bootstrap stores supplied hash with forced ADMIN role and returns no password', async () => {
  const input = {
    fullName: 'Admin',
    phone: '0123456789',
    email: 'admin@example.com',
    password: 'hash',
  };
  let calls = 0;
  const repository = new UsersRepository({
    transaction: async (work) =>
      work({
        query: async (sql, values) => {
          calls++;
          if (calls === 1) assert(sql.includes('pg_advisory_xact_lock'));
          if (calls === 3) {
            assert(sql.includes("'ADMIN'"));
            assert(!sql.split('RETURNING')[1].includes('password'));
            assert.deepEqual(values, Object.values(input));
            return { rows: [{ id: 'new-admin', role: 'ADMIN' }] };
          }
          return { rowCount: 0 };
        },
      }),
  });
  assert.equal((await repository.bootstrapAdmin(input)).role, 'ADMIN');
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
