/* eslint-disable @typescript-eslint/no-require-imports */
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ConfigModule } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { AuthModule } = require('../dist/modules/auth/auth.module');
const { AuthService } = require('../dist/modules/auth/auth.service');
const {
  AuthSessionRepository,
} = require('../dist/modules/auth/auth-session.repository');
const { HealthModule } = require('../dist/modules/health/health.module');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { DatabaseService } = require('../dist/database/database.service');
const { PasswordService } = require('../dist/modules/users/password.service');
const { validateEnvironment } = require('../dist/config/environment');
const { setupApp } = require('../dist/setup-app');

const config = validateEnvironment({
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64'),
  JWT_ACCESS_EXPIRES_IN: '15m',
});
const password = '  a long unchanged password  ';
let passwordHash;
async function fixture(t, overrides = {}) {
  const activeConfig = validateEnvironment({ ...config, ...overrides });
  passwordHash ??= await new PasswordService().hashPassword(password);
  const users = new Map(
    ['ADMIN', 'TEACHER', 'STUDENT'].map((role) => [
      role,
      {
        id: role,
        fullName: `${role} User`,
        email: `${role.toLowerCase()}@example.com`,
        role,
        status: true,
        password: passwordHash,
        phone: '0123456789',
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordHash: 'never-return-this',
      },
    ]),
  );
  let databaseError = false;
  let sessionError = false;
  const sessions = new Map(
    [...users.keys()].map((id) => [
      `session-${id}`,
      {
        id: `session-${id}`,
        userId: id,
        client: 'student',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 604800000),
      },
    ]),
  );
  const tokens = new Map();
  const sessionRepository = {
    create: async (userId, client, hash, expiresAt, issue) => {
      if (sessionError) throw new Error('sensitive-session-error');
      const session = {
        id: randomBytes(16).toString('hex'),
        userId,
        client,
        expiresAt,
        revokedAt: null,
      };
      const result = await issue(session);
      sessions.set(session.id, session);
      tokens.set(hash, { sessionId: session.id, consumedAt: null });
      return result;
    },
    withToken: async (hash, client, work) => {
      const token = tokens.get(hash);
      const session = token ? sessions.get(token.sessionId) : null;
      return work(
        session?.client === client
          ? { session, consumedAt: token.consumedAt }
          : null,
        {},
      );
    },
    rotate: async (id, hash, next) => {
      tokens.get(hash).consumedAt = new Date();
      tokens.set(next, { sessionId: id, consumedAt: null });
    },
    revoke: async (id) => {
      sessions.get(id).revokedAt = new Date();
    },
    isActive: async (id, userId) => {
      const s = sessions.get(id);
      return (
        !!s &&
        s.userId === userId &&
        !s.revokedAt &&
        s.expiresAt.getTime() > Date.now()
      );
    },
  };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => activeConfig],
      }),
      AuthModule,
      HealthModule,
    ],
  })
    .overrideProvider(UsersRepository)
    .useValue({
      findCredentialsByEmail: async (email) => {
        if (databaseError) throw new Error('sensitive-database-details');
        return (
          [...users.values()].find(
            (u) => u.email === email.trim().toLowerCase(),
          ) ?? null
        );
      },
      findById: async (id) => {
        if (databaseError) throw new Error('sensitive-database-details');
        return users.get(id) ?? null;
      },
    })
    .overrideProvider(DatabaseService)
    .useValue({ checkConnection: async () => {} })
    .overrideProvider(AuthSessionRepository)
    .useValue(sessionRepository)
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      ...options,
      headers: { Origin: activeConfig.AUTH_STUDENT_ORIGIN, ...options.headers },
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  };
  const login = (body, headers = {}) =>
    request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return {
    app,
    users,
    request,
    login,
    jwt: app.get(JwtService),
    base,
    sessions,
    tokens,
    setSessionError: () => {
      sessionError = true;
    },
    setDatabaseError: () => {
      databaseError = true;
    },
  };
}

test('HTTP login accepts all three roles and returns exact safe contract and minimal JWT', async (t) => {
  const f = await fixture(t);
  for (const role of ['ADMIN', 'TEACHER', 'STUDENT']) {
    const r = await f.login({ email: `  ${role}@EXAMPLE.COM  `, password });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), [
      'accessToken',
      'expiresIn',
      'tokenType',
      'user',
    ]);
    assert.equal(r.body.tokenType, 'Bearer');
    assert.equal(r.body.expiresIn, 900);
    assert.deepEqual(r.body.user, {
      id: role,
      fullName: `${role} User`,
      email: `${role.toLowerCase()}@example.com`,
      role,
      isActive: true,
    });
    const claims = await f.jwt.verifyAsync(r.body.accessToken);
    assert.deepEqual(Object.keys(claims).sort(), [
      'aud',
      'exp',
      'iat',
      'iss',
      'role',
      'sid',
      'sub',
    ]);
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal(claims.iss, 'clover-lms-api');
    assert.equal(claims.aud, 'clover-lms');
    assert(!JSON.stringify(r.body).includes(passwordHash));
  }
});

test('unknown email, incorrect password and inactive user return the same 401', async (t) => {
  const f = await fixture(t);
  const a = await f.login({ email: 'unknown@example.com', password });
  const b = await f.login({
    email: 'admin@example.com',
    password: 'wrong password',
  });
  f.users.get('ADMIN').status = false;
  const c = await f.login({ email: 'admin@example.com', password });
  for (const r of [a, b, c]) assert.equal(r.status, 401);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(b.body, c.body);
});

test('HTTP validation rejects missing/invalid/extra login fields', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { email: 'admin@example.com' },
    { password },
    { email: 'invalid', password },
    { email: 'admin@example.com', password: '' },
    { email: 'admin@example.com', password, role: 'ADMIN' },
  ]) {
    const r = await f.login(body);
    assert.equal(r.status, 400);
    assert(!JSON.stringify(r.body).includes(password));
  }
});

test('login preserves password whitespace and verifies unknown emails against a dummy hash', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.login({ email: 'admin@example.com', password: password.trim() }))
      .status,
    401,
  );
  const auth = f.app.get(AuthService);
  const passwords = f.app.get(PasswordService);
  const original = passwords.verifyPassword.bind(passwords);
  let verified = false;
  passwords.verifyPassword = async (p, hash) => {
    assert.equal(p, password);
    assert.match(hash, /^\$argon2id\$/);
    verified = true;
    return original(p, hash);
  };
  await assert.rejects(
    auth.login('missing@example.com', password),
    (error) => error.getStatus() === 401,
  );
  assert(verified);
});

test('login throttles the sixth request and ignores spoofed forwarding headers', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await f.login(
          { email: 'missing@example.com', password },
          { 'X-Forwarded-For': `1.2.3.${i}` },
        )
      ).status,
      401,
    );
  const r = await f.login(
    { email: 'admin@example.com', password },
    { 'X-Forwarded-For': '9.9.9.9' },
  );
  assert.equal(r.status, 429);
  assert(r.headers.has('retry-after'));
  assert.equal((await f.request('/health')).status, 200);
});

test('me requires a token and returns safe current information for all roles', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/me')).status, 401);
  for (const role of ['ADMIN', 'TEACHER', 'STUDENT']) {
    const login = await f.login({
      email: `${role.toLowerCase()}@example.com`,
      password,
    });
    const r = await f.request('/auth/me', {
      headers: { Authorization: `Bearer ${login.body.accessToken}` },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, login.body.user);
  }
});

test('me rejects expired, tampered, malformed, wrong issuer/audience/algorithm and incomplete JWTs', async (t) => {
  const f = await fixture(t);
  const claims = { sub: 'ADMIN', role: 'ADMIN', sid: 'session-ADMIN' };
  const tokens = [
    'malformed',
    await f.jwt.signAsync(claims, { expiresIn: -1 }),
    await f.jwt.signAsync(claims, {
      secret: randomBytes(48).toString('base64'),
    }),
    await f.jwt.signAsync(claims, { issuer: 'wrong-issuer' }),
    await f.jwt.signAsync(claims, { audience: 'wrong-audience' }),
    await f.jwt.signAsync(claims, { algorithm: 'HS384' }),
    await f.jwt.signAsync({ role: 'ADMIN' }),
    await f.jwt.signAsync({ sub: 'ADMIN', role: 'ADMIN' }),
    await new JwtService({
      secret: config.JWT_ACCESS_SECRET,
      signOptions: {
        algorithm: 'HS256',
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
    }).signAsync(claims),
    await f.jwt.signAsync(claims, { noTimestamp: true }),
    await f.jwt.signAsync({ ...claims, sub: '' }),
  ];
  for (const token of tokens)
    assert.equal(
      (
        await f.request('/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  for (const authorization of ['Basic xyz', 'Bearer', 'Bearer token extra'])
    assert.equal(
      (
        await f.request('/auth/me', {
          headers: { Authorization: authorization },
        })
      ).status,
      401,
    );
});

test('me rejects deleted/inactive accounts and uses the current database role', async (t) => {
  const f = await fixture(t);
  const token = await f.jwt.signAsync({
    sub: 'ADMIN',
    role: 'ADMIN',
    sid: 'session-ADMIN',
  });
  const options = { headers: { Authorization: `Bearer ${token}` } };
  f.users.get('ADMIN').role = 'TEACHER';
  f.users.get('ADMIN').fullName = 'Updated name';
  let r = await f.request('/auth/me', options);
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'TEACHER');
  assert.equal(r.body.fullName, 'Updated name');
  f.users.get('ADMIN').status = false;
  assert.equal((await f.request('/auth/me', options)).status, 401);
  f.users.delete('ADMIN');
  assert.equal((await f.request('/auth/me', options)).status, 401);
});

test('database failures return a safe 503 without database details', async (t) => {
  const f = await fixture(t);
  const token = await f.jwt.signAsync({
    sub: 'ADMIN',
    role: 'ADMIN',
    sid: 'session-ADMIN',
  });
  f.setDatabaseError();
  for (const r of [
    await f.login({ email: 'admin@example.com', password }),
    await f.request('/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]) {
    assert.equal(r.status, 503);
    assert(!JSON.stringify(r.body).includes('sensitive-database-details'));
  }
});

test('existing health endpoints and Swagger contracts remain available', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/health')).status, 200);
  assert.deepEqual((await f.request('/health/database')).body, {
    status: 'ok',
    database: 'connected',
  });
  const docs = await f.request('/docs-json');
  assert.equal(docs.status, 200);
  assert(docs.body.paths['/api/auth/login'].post.responses['200']);
  assert(docs.body.paths['/api/auth/login'].post.responses['429']);
  assert.deepEqual(docs.body.paths['/api/auth/me'].get.security, [
    { bearer: [] },
  ]);
  assert.deepEqual(docs.body.paths['/api/auth/refresh'].post.security, [
    { refreshCookie: [] },
  ]);
  assert(docs.body.paths['/api/auth/logout'].post.responses['204']);
  assert.equal(docs.body.components.securitySchemes.refreshCookie.in, 'cookie');
  assert(docs.body.components.schemas.LoginDto.required.includes('password'));
  assert(
    !JSON.stringify(docs.body.components.schemas.AuthUserDto).includes(
      'password',
    ),
  );
});

test('JWT environment rejects missing/weak secrets and invalid lifetimes, issuer or audience', () => {
  for (const JWT_ACCESS_SECRET of [
    undefined,
    'short',
    'x'.repeat(64),
    'replace-me-with-a-secret-1234567890',
  ])
    assert.throws(() => validateEnvironment({ JWT_ACCESS_SECRET }));
  for (const JWT_ACCESS_EXPIRES_IN of ['', '0', '15', '30d', 'abc', '1.5m'])
    assert.throws(() =>
      validateEnvironment({ ...config, JWT_ACCESS_EXPIRES_IN }),
    );
  assert.throws(() => validateEnvironment({ ...config, JWT_ISSUER: ' ' }));
  assert.throws(() => validateEnvironment({ ...config, JWT_AUDIENCE: ' ' }));
  assert.equal(
    validateEnvironment({ JWT_ACCESS_SECRET: config.JWT_ACCESS_SECRET })
      .JWT_ACCESS_EXPIRES_SECONDS,
    900,
  );
  assert.equal(
    validateEnvironment({ ...config, JWT_ACCESS_EXPIRES_IN: '5m' })
      .JWT_ACCESS_EXPIRES_SECONDS,
    300,
  );
});

const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];

test('frontend API contract matches Swagger and Nest error shapes throughout the session lifecycle', async (t) => {
  const f = await fixture(t);
  const invalid = await f.login({ email: 'student@example.com' });
  assert.equal(invalid.status, 400);
  assert(Array.isArray(invalid.body.message));
  assert.deepEqual(Object.keys(invalid.body).sort(), [
    'error',
    'message',
    'statusCode',
  ]);
  const wrong = await f.login({
    email: 'student@example.com',
    password: 'wrong',
  });
  assert.equal(wrong.status, 401);
  assert.equal(typeof wrong.body.message, 'string');
  const login = await f.login({ email: 'student@example.com', password });
  const docs = (await f.request('/docs-json')).body;
  const required = docs.components.schemas.LoginResponseDto.required;
  assert.deepEqual(Object.keys(login.body).sort(), [...required].sort());
  assert.deepEqual(
    Object.keys(login.body.user).sort(),
    [...docs.components.schemas.AuthUserDto.required].sort(),
  );
  const refresh = await f.request('/auth/refresh', {
    method: 'POST',
    headers: { Cookie: cookieOf(login) },
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(Object.keys(refresh.body).sort(), [...required].sort());
  assert.deepEqual(refresh.body.user, login.body.user);
  const me = await f.request('/auth/me', {
    headers: { Authorization: `Bearer ${refresh.body.accessToken}` },
  });
  assert.deepEqual(me.body, refresh.body.user);
  const logout = await f.request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookieOf(refresh) },
  });
  assert.equal(logout.status, 204);
  assert.equal(logout.body, null);
});

test('login sets a host-only HttpOnly cookie but stores and returns no raw token', async (t) => {
  const f = await fixture(t);
  const before = f.sessions.size;
  const r = await f.login({ email: 'admin@example.com', password });
  assert.equal(r.status, 200);
  assert.equal(f.sessions.size, before + 1);
  const header = r.headers.get('set-cookie');
  assert.match(header, /^clover_refresh_student=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\/api\/auth/);
  assert(!header.includes('Domain='));
  assert(!header.includes('Secure'));
  assert.match(header, /Max-Age=60479\d|Max-Age=604800/);
  const raw = cookieOf(r).split('=')[1];
  assert.equal(raw.length, 43);
  assert(!JSON.stringify(r.body).includes(raw));
  assert(!Object.hasOwn(r.body, 'refreshToken'));
  const { createHash } = require('node:crypto');
  assert(f.tokens.has(createHash('sha256').update(raw).digest('hex')));
  assert(!JSON.stringify([...f.tokens]).includes(raw));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('failed credentials and failed session storage never produce a successful login', async (t) => {
  const f = await fixture(t);
  const before = f.sessions.size;
  const invalid = await f.login({
    email: 'admin@example.com',
    password: 'wrong',
  });
  assert.equal(invalid.status, 401);
  assert.equal(f.sessions.size, before);
  assert(!invalid.headers.has('set-cookie'));
  f.setSessionError();
  const failed = await f.login({ email: 'admin@example.com', password });
  assert.equal(failed.status, 503);
  assert.equal(f.sessions.size, before);
  assert(!failed.headers.has('set-cookie'));
});

test('refresh rotates opaque cookies without an access token; replay revokes only that session', async (t) => {
  const f = await fixture(t);
  const first = await f.login({ email: 'admin@example.com', password });
  const other = await f.login({ email: 'admin@example.com', password });
  const fresh = await f.request('/auth/refresh', {
    method: 'POST',
    headers: { Cookie: cookieOf(first), Authorization: 'Bearer expired-token' },
  });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.user, first.body.user);
  assert.notEqual(cookieOf(fresh), cookieOf(first));
  assert.deepEqual(Object.keys(fresh.body).sort(), [
    'accessToken',
    'expiresIn',
    'tokenType',
    'user',
  ]);
  const replay = await f.request('/auth/refresh', {
    method: 'POST',
    headers: { Cookie: cookieOf(first) },
  });
  assert.equal(replay.status, 401);
  assert.match(replay.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal(
    (
      await f.request('/auth/me', {
        headers: { Authorization: `Bearer ${fresh.body.accessToken}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request('/auth/me', {
        headers: { Authorization: `Bearer ${other.body.accessToken}` },
      })
    ).status,
    200,
  );
});

test('logout clears matching cookie attributes, is idempotent and invalidates only its session JWT', async (t) => {
  const f = await fixture(t);
  const a = await f.login({ email: 'admin@example.com', password });
  const b = await f.login({ email: 'admin@example.com', password });
  for (const cookie of [cookieOf(a), cookieOf(a), '']) {
    const r = await f.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(r.status, 204);
    assert.equal(r.body, null);
    const clear = r.headers.get('set-cookie');
    assert.match(clear, /clover_refresh_student=;/);
    assert.match(clear, /HttpOnly/);
    assert.match(clear, /Path=\/api\/auth/);
    assert.match(clear, /SameSite=Lax/);
    assert.match(clear, /Expires=Thu, 01 Jan 1970/);
  }
  assert.equal(
    (
      await f.request('/auth/me', {
        headers: { Authorization: `Bearer ${a.body.accessToken}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request('/auth/me', {
        headers: { Authorization: `Bearer ${b.body.accessToken}` },
      })
    ).status,
    200,
  );
});

test('refresh rejects missing/malformed cookies, expired/revoked sessions and inactive users', async (t) => {
  const f = await fixture(t);
  for (const cookie of ['', 'clover_refresh_student=malformed']) {
    assert.equal(
      (
        await f.request('/auth/refresh', {
          method: 'POST',
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
  }
  for (const state of ['expired', 'revoked', 'inactive']) {
    const r = await f.login({ email: 'admin@example.com', password });
    const claims = f.jwt.decode(r.body.accessToken);
    const session = f.sessions.get(claims.sid);
    if (state === 'expired') session.expiresAt = new Date(0);
    if (state === 'revoked') session.revokedAt = new Date();
    if (state === 'inactive') f.users.get('ADMIN').status = false;
    assert.equal(
      (
        await f.request('/auth/refresh', {
          method: 'POST',
          headers: { Cookie: cookieOf(r) },
        })
      ).status,
      401,
    );
  }
});

test('deleted users cannot refresh and JWTs without sid or with another user session fail', async (t) => {
  const f = await fixture(t);
  const login = await f.login({ email: 'admin@example.com', password });
  f.users.delete('ADMIN');
  assert.equal(
    (
      await f.request('/auth/refresh', {
        method: 'POST',
        headers: { Cookie: cookieOf(login) },
      })
    ).status,
    401,
  );
  for (const claims of [
    { sub: 'STUDENT', role: 'STUDENT' },
    { sub: 'STUDENT', role: 'STUDENT', sid: 'session-TEACHER' },
  ]) {
    const token = await f.jwt.signAsync(claims);
    assert.equal(
      (
        await f.request('/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  }
});

test('CSRF requires a trusted Origin for login, refresh and logout; CORS supports credentials', async (t) => {
  const f = await fixture(t);
  for (const endpoint of ['login', 'refresh', 'logout']) {
    for (const origin of [undefined, 'null', 'https://attacker.example']) {
      const headers = { 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      const r = await fetch(`${f.base}/api/auth/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'admin@example.com', password }),
      });
      assert.equal(r.status, 403);
    }
  }
  const allowed = await f.login({ email: 'admin@example.com', password });
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  const denied = await f.request('/auth/logout', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(denied.status, 403);
  assert(!denied.headers.has('access-control-allow-origin'));
});

test('Student and CMS select separate cookies by Origin, not a caller-supplied client name', async (t) => {
  const f = await fixture(t);
  const student = await f.login({ email: 'student@example.com', password });
  const admin = await f.login(
    { email: 'admin@example.com', password },
    { Origin: 'http://localhost:5174' },
  );
  assert.match(cookieOf(student), /^clover_refresh_student=/);
  assert.match(cookieOf(admin), /^clover_refresh_admin=/);
  const both = `${cookieOf(student)}; ${cookieOf(admin)}`;
  const r = await f.request('/auth/refresh', {
    method: 'POST',
    headers: { Cookie: both, 'X-Auth-Client': 'admin' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'STUDENT');
  const cms = await f.request('/auth/refresh', {
    method: 'POST',
    headers: { Cookie: both, Origin: 'http://localhost:5174' },
  });
  assert.equal(cms.status, 200);
  assert.equal(cms.body.user.role, 'ADMIN');
  assert.equal(
    (
      await f.request('/auth/refresh', {
        method: 'POST',
        headers: { Cookie: cookieOf(admin) },
      })
    ).status,
    401,
  );
});

test('production cookie is Secure and cookie configuration rejects unsafe combinations', async (t) => {
  const production = {
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://learn.example.com,https://cms.example.com',
    AUTH_STUDENT_ORIGIN: 'https://learn.example.com',
    AUTH_ADMIN_ORIGIN: 'https://cms.example.com',
    AUTH_DOCS_ORIGIN: '',
    AUTH_COOKIE_SECURE: true,
  };
  const f = await fixture(t, production);
  const r = await f.login({ email: 'admin@example.com', password });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /; Secure/);
  for (const override of [
    { AUTH_COOKIE_SECURE: false },
    { AUTH_STUDENT_ORIGIN: 'http://localhost:5173' },
  ]) {
    assert.throws(() =>
      validateEnvironment({ ...config, ...production, ...override }),
    );
  }
  for (const override of [
    { AUTH_COOKIE_SAME_SITE: 'none', AUTH_COOKIE_SECURE: false },
    { AUTH_REFRESH_EXPIRES_IN: '0' },
    { AUTH_REFRESH_EXPIRES_IN: '999d' },
    { AUTH_COOKIE_PATH: '/wrong' },
    { AUTH_COOKIE_NAME: 'bad;name' },
    { CORS_ORIGIN: '*' },
    { AUTH_ADMIN_ORIGIN: 'http://localhost:5173' },
    { AUTH_COOKIE_NAME: '__Host-test', AUTH_COOKIE_PATH: '/api/auth' },
  ]) {
    assert.throws(() => validateEnvironment({ ...config, ...override }));
  }
  const crossSite = validateEnvironment({
    ...config,
    AUTH_COOKIE_SAME_SITE: 'none',
    AUTH_COOKIE_SECURE: true,
  });
  assert.equal(crossSite.AUTH_COOKIE_SAME_SITE, 'none');
});
