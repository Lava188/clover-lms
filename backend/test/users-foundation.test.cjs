/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  UsersRepository,
  DuplicateUserError,
  toPublicUser,
} = require('../dist/modules/users/users.repository');
const { UsersService } = require('../dist/modules/users/users.service');
const { PasswordService } = require('../dist/modules/users/password.service');

const account = {
  id: 'account-1',
  fullName: 'Student',
  phone: '0123456789',
  email: 'student@example.com',
  role: 'STUDENT',
  status: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const secretRow = {
  ...account,
  password: 'secret',
  passwordHash: 'secret',
  unexpected: 'internal',
};

test('public mapping explicitly excludes all non-public fields', () => {
  assert.deepEqual(toPublicUser(secretRow), account);
});

test('repository lookups normalize email, bind values and sanitize public results', async () => {
  const queries = [];
  const repo = new UsersRepository({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [secretRow] };
    },
  });
  assert.deepEqual(await repo.findById("id' OR 1=1 --"), account);
  assert.deepEqual(await repo.findByEmail('  STUDENT@example.com '), account);
  assert.deepEqual(queries[0].values, ["id' OR 1=1 --"]);
  assert.deepEqual(queries[1].values, ['student@example.com']);
  for (const { sql } of queries) {
    assert(!sql.includes('password'));
    assert(sql.includes('$1'));
  }
});

test('repository returns null for absent user', async () => {
  const repo = new UsersRepository({ query: async () => ({ rows: [] }) });
  assert.equal(await repo.findById('absent'), null);
  assert.equal(await repo.findByEmail('absent@example.com'), null);
  assert.equal(await repo.updatePassword('absent', 'hash'), null);
});

test('createUser binds a hash and nullable phone and sanitizes result', async () => {
  const repo = new UsersRepository({
    query: async (sql, values) => {
      assert(sql.includes('VALUES ($1, $2, $3, $4, $5, $6)'));
      assert(!sql.includes('hashed-value'));
      assert.deepEqual(values, [
        'Student',
        'student@example.com',
        null,
        'hashed-value',
        'STUDENT',
        true,
      ]);
      return { rows: [{ ...secretRow, phone: null }] };
    },
  });
  const result = await repo.createUser({
    fullName: 'Student',
    email: ' STUDENT@example.com ',
    phone: null,
    passwordHash: 'hashed-value',
    role: 'STUDENT',
    status: true,
  });
  assert.deepEqual(result, { ...account, phone: null });
});

for (const [constraint, field] of [
  ['user_email_unique', 'email'],
  ['User_phone_key', 'phone'],
]) {
  test(`repository translates duplicate ${field} without exposing database detail`, async () => {
    const repo = new UsersRepository({
      query: async () => {
        throw { code: '23505', constraint, detail: 'sensitive value' };
      },
    });
    await assert.rejects(
      repo.createUser({ email: 'student@example.com' }),
      (error) =>
        error instanceof DuplicateUserError &&
        error.field === field &&
        !error.message.includes('sensitive'),
    );
  });
}

test('unrelated database errors are not mislabeled as duplicate email', async () => {
  const error = { code: '08006' };
  const repo = new UsersRepository({
    query: async () => {
      throw error;
    },
  });
  await assert.rejects(
    repo.createUser({ email: 'student@example.com' }),
    (actual) => actual === error,
  );
});

test('service normalizes creation, hashes password and preserves phone leading zeroes', async () => {
  const password = 'a sufficiently long password';
  const passwords = new PasswordService();
  let stored;
  const service = new UsersService(
    {
      createUser: async (input) => {
        stored = input;
        return account;
      },
    },
    passwords,
  );
  assert.deepEqual(
    await service.createUser({
      fullName: ' Student ',
      email: ' STUDENT@example.com ',
      phone: ' 0123456789 ',
      password,
    }),
    account,
  );
  assert.equal(stored.phone, '0123456789');
  assert.equal(stored.email, 'student@example.com');
  assert.equal(stored.role, 'STUDENT');
  assert.equal(stored.status, true);
  assert(!Object.hasOwn(stored, 'password'));
  assert.equal(
    await passwords.verifyPassword(password, stored.passwordHash),
    true,
  );
});

test('service treats omitted and blank phone as null', async () => {
  const service = new UsersService(
    {
      createUser: async (input) => {
        assert.equal(input.phone, null);
        return account;
      },
    },
    { hashPassword: async () => 'hash' },
  );
  for (const phone of [undefined, null, ' '])
    await service.createUser({
      fullName: 'Student',
      email: 'student@example.com',
      phone,
      password: 'password',
    });
});

test('service translates database email race to HTTP 409', async () => {
  const service = new UsersService(
    {
      createUser: async () => {
        throw new DuplicateUserError('email');
      },
    },
    { hashPassword: async () => 'hash' },
  );
  await assert.rejects(
    service.createUser({
      fullName: 'Student',
      email: 'student@example.com',
      password: 'password',
    }),
    (error) => error.getStatus() === 409,
  );
});

test('service rejects invalid values before writing', async () => {
  const service = new UsersService(
    { createUser: async () => assert.fail('Unexpected write') },
    { hashPassword: async () => assert.fail('Unexpected hashing') },
  );
  const valid = {
    fullName: 'Student',
    email: 'student@example.com',
    password: 'password',
  };
  for (const override of [
    { fullName: ' ' },
    { email: 'invalid' },
    { phone: 123 },
    { role: 'OWNER' },
    { status: 'true' },
  ]) {
    await assert.rejects(
      service.createUser({ ...valid, ...override }),
      (error) => error.getStatus() === 400,
    );
  }
});

test('password update binds parameters and never returns credentials', async () => {
  const repo = new UsersRepository({
    query: async (sql, values) => {
      assert(sql.includes('SET "password" = $2 WHERE "id" = $1'));
      assert.deepEqual(values, ['account-1', 'new-hash']);
      return { rows: [secretRow] };
    },
  });
  assert.deepEqual(await repo.updatePassword('account-1', 'new-hash'), account);
});

test('service hashes replacement password and returns 404 for missing user', async () => {
  const service = new UsersService(
    {
      updatePassword: async (id, hash) => {
        assert.equal(id, 'missing');
        assert.equal(hash, 'new-hash');
        return null;
      },
    },
    {
      hashPassword: async (password) => {
        assert.equal(password, 'new password');
        return 'new-hash';
      },
    },
  );
  await assert.rejects(
    service.updatePassword('missing', 'new password'),
    (error) => error.getStatus() === 404,
  );
});
