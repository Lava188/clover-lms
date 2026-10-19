/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  UsersService,
  AdminAlreadyExistsError,
} = require('../dist/modules/users/users.service');
const {
  DuplicateUserError,
} = require('../dist/modules/users/users.repository');

const valid = {
  fullName: ' Initial Admin ',
  email: ' ADMIN@example.com ',
  password: 'a long bootstrap password',
};
const passwords = { hashPassword: async () => '$argon2id$test-hash' };

test('bootstrap validates, normalizes and hashes with the shared services', async () => {
  const client = {};
  let inserted;
  const service = new UsersService(
    {
      withBootstrapLock: async (work) => work(client),
      hasAdmin: async (received) => {
        assert.equal(received, client);
        return false;
      },
      createUser: async (record, received) => {
        assert.equal(received, client);
        inserted = record;
        return { id: 'admin', role: record.role };
      },
    },
    passwords,
  );
  assert.equal(
    (
      await service.bootstrapFirstAdmin({
        ...valid,
        role: 'STUDENT',
        status: false,
      })
    ).role,
    'ADMIN',
  );
  assert.deepEqual(inserted, {
    fullName: 'Initial Admin',
    email: 'admin@example.com',
    passwordHash: '$argon2id$test-hash',
    phone: null,
    role: 'ADMIN',
    status: true,
  });
});

test('an existing administrator stops bootstrap with no writes', async () => {
  const service = new UsersService(
    {
      withBootstrapLock: async (work) => work({}),
      hasAdmin: async () => true,
      createUser: async () => assert.fail('Unexpected write'),
    },
    passwords,
  );
  await assert.rejects(
    service.bootstrapFirstAdmin(valid),
    AdminAlreadyExistsError,
  );
});

test('duplicate email fails without promoting an existing account', async () => {
  const service = new UsersService(
    {
      withBootstrapLock: async (work) => work({}),
      hasAdmin: async () => false,
      createUser: async () => {
        throw new DuplicateUserError('email');
      },
    },
    passwords,
  );
  await assert.rejects(
    service.bootstrapFirstAdmin(valid),
    (error) => error.getStatus() === 409,
  );
});

test('invalid bootstrap values never enter the database transaction', async () => {
  const service = new UsersService(
    { withBootstrapLock: async () => assert.fail('Unexpected transaction') },
    passwords,
  );
  for (const override of [
    { fullName: '' },
    { email: 'invalid' },
    { phone: 123 },
  ]) {
    await assert.rejects(
      service.bootstrapFirstAdmin({ ...valid, ...override }),
      (error) => error.getStatus() === 400,
    );
  }
});

test('invalid password stops bootstrap before entering the transaction', async () => {
  const { PasswordService } = require('../dist/modules/users/password.service');
  const service = new UsersService(
    { withBootstrapLock: async () => assert.fail('Unexpected transaction') },
    new PasswordService(),
  );
  await assert.rejects(
    service.bootstrapFirstAdmin({ ...valid, password: 'short' }),
    (error) => error.getStatus() === 400,
  );
});

test('CLI rejects missing environment and never echoes a password', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('BOOTSTRAP_ADMIN_')) delete env[key];
  env.BOOTSTRAP_ADMIN_PASSWORD = 'secret-not-to-be-printed';
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/bootstrap-admin.ts')],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set BOOTSTRAP_ADMIN_NAME/);
  assert(!result.stderr.includes(env.BOOTSTRAP_ADMIN_PASSWORD));
  assert(!result.stdout.includes(env.BOOTSTRAP_ADMIN_PASSWORD));
});
