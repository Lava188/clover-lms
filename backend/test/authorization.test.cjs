/* eslint-disable @typescript-eslint/no-require-imports */
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Controller, Get, UseGuards } = require('@nestjs/common');
const {
  GUARDS_METADATA,
  ROUTE_ARGS_METADATA,
} = require('@nestjs/common/constants');
const { Reflector } = require('@nestjs/core');
const { Test } = require('@nestjs/testing');
const { ConfigModule } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { USER_ROLES, ROLE_POLICIES } = require('../dist/common/auth.types');
const {
  Roles,
  ROLES_KEY,
} = require('../dist/common/decorators/roles.decorator');
const {
  RequireRoles,
} = require('../dist/common/decorators/require-roles.decorator');
const {
  CurrentUser,
} = require('../dist/common/decorators/current-user.decorator');
const { RolesGuard } = require('../dist/common/guards/roles.guard');
const { JwtAuthGuard } = require('../dist/modules/auth/jwt-auth.guard');
const { AuthModule } = require('../dist/modules/auth/auth.module');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const {
  AuthSessionRepository,
} = require('../dist/modules/auth/auth-session.repository');
const { validateEnvironment } = require('../dist/config/environment');
const { setupApp } = require('../dist/setup-app');

function metadata(roles, methodRoles) {
  class Sample {
    handler() {}
  }
  if (roles) Roles(...roles)(Sample);
  if (methodRoles)
    Roles(...methodRoles)(
      Sample.prototype,
      'handler',
      Object.getOwnPropertyDescriptor(Sample.prototype, 'handler'),
    );
  return { getClass: () => Sample, getHandler: () => Sample.prototype.handler };
}
function context(meta, user) {
  return { ...meta, switchToHttp: () => ({ getRequest: () => ({ user }) }) };
}
const safeUser = (role) => ({
  id: 'user-id',
  email: 'user@example.test',
  fullName: 'Test User',
  role,
  isActive: true,
});
const guard = new RolesGuard(new Reflector());

test('CurrentUser requires existing auth context and maps only public fields', () => {
  class Sample {
    handler() {}
  }
  CurrentUser()(Sample.prototype, 'handler', 0);
  const params = Reflect.getMetadata(ROUTE_ARGS_METADATA, Sample, 'handler');
  const factory = Object.values(params)[0].factory;
  const meta = {
    getClass: () => Sample,
    getHandler: () => Sample.prototype.handler,
  };
  assert.throws(
    () => factory(undefined, context(meta, undefined)),
    (e) => e.getStatus() === 401,
  );
  assert.deepEqual(
    factory(
      undefined,
      context(meta, {
        ...safeUser('ADMIN'),
        password: 'secret',
        passwordHash: 'hash',
        sid: 'internal',
        refreshTokenHash: 'digest',
      }),
    ),
    safeUser('ADMIN'),
  );
});

test('Roles supports single/multiple/class/method metadata and method overrides class', () => {
  const single = metadata(['ADMIN']);
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, single.getClass()), [
    'ADMIN',
  ]);
  const multiple = metadata(['ADMIN', 'TEACHER']);
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, multiple.getClass()), [
    'ADMIN',
    'TEACHER',
  ]);
  const method = metadata(undefined, ['STUDENT']);
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, method.getHandler()), [
    'STUDENT',
  ]);
  const both = metadata(['ADMIN', 'TEACHER'], ['STUDENT']);
  assert.equal(guard.canActivate(context(both, safeUser('STUDENT'))), true);
  assert.throws(
    () => guard.canActivate(context(both, safeUser('ADMIN'))),
    (e) => e.getStatus() === 403,
  );
  assert.throws(() => Roles());
  assert.throws(() => Roles('OWNER'));
});

test('Roles metadata alone never installs guards; RequireRoles composes authentication first', () => {
  const sample = metadata(['ADMIN']);
  assert.equal(
    Reflect.getMetadata(GUARDS_METADATA, sample.getClass()),
    undefined,
  );
  class Protected {}
  RequireRoles('ADMIN')(Protected);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, Protected), [
    JwtAuthGuard,
    RolesGuard,
  ]);
});

for (const [policy, allowed] of [
  [ROLE_POLICIES.ADMIN_ONLY, ['ADMIN']],
  [ROLE_POLICIES.CMS, ['ADMIN', 'TEACHER']],
  [ROLE_POLICIES.STUDENT_ONLY, ['STUDENT']],
]) {
  test(`RolesGuard enforces ${policy.join('/')} without implicit ADMIN bypass`, () => {
    for (const role of Object.values(USER_ROLES)) {
      const call = () =>
        guard.canActivate(context(metadata(policy), safeUser(role)));
      if (allowed.includes(role)) assert.equal(call(), true);
      else assert.throws(call, (e) => e.getStatus() === 403);
    }
  });
}

test('RolesGuard denies missing/inactive auth context even without metadata, and denies unknown roles', () => {
  for (const meta of [metadata(), metadata(['ADMIN'])]) {
    for (const user of [
      undefined,
      { ...safeUser('ADMIN'), isActive: false },
      { ...safeUser('ADMIN'), id: '' },
    ])
      assert.throws(
        () => guard.canActivate(context(meta, user)),
        (e) => e.getStatus() === 401,
      );
    for (const role of ['OWNER', '', undefined])
      assert.throws(
        () => guard.canActivate(context(meta, safeUser(role))),
        (e) => e.getStatus() === 403,
      );
  }
  assert.equal(
    guard.canActivate(context(metadata(), safeUser('STUDENT'))),
    true,
  );
});

// These controllers exist only inside this test suite, never in AppModule.
class ProtectedController {
  admin(user) {
    return user;
  }
  cms(user) {
    return user;
  }
  student(user) {
    return user;
  }
  authenticated(user) {
    return user;
  }
}
Controller('authorization-test')(ProtectedController);
for (const [name, policy] of [
  ['admin', ROLE_POLICIES.ADMIN_ONLY],
  ['cms', ROLE_POLICIES.CMS],
  ['student', ROLE_POLICIES.STUDENT_ONLY],
  ['authenticated', null],
]) {
  const descriptor = Object.getOwnPropertyDescriptor(
    ProtectedController.prototype,
    name,
  );
  Get(name)(ProtectedController.prototype, name, descriptor);
  if (policy)
    RequireRoles(...policy)(ProtectedController.prototype, name, descriptor);
  else
    UseGuards(JwtAuthGuard, RolesGuard)(
      ProtectedController.prototype,
      name,
      descriptor,
    );
  CurrentUser()(ProtectedController.prototype, name, 0);
}
class ClassPolicyController {
  inherited(user) {
    return user;
  }
  restricted(user) {
    return user;
  }
  overridden(user) {
    return user;
  }
}
Controller('class-policy-test')(ClassPolicyController);
RequireRoles(...ROLE_POLICIES.CMS)(ClassPolicyController);
for (const name of ['inherited', 'restricted', 'overridden']) {
  Get(name)(
    ClassPolicyController.prototype,
    name,
    Object.getOwnPropertyDescriptor(ClassPolicyController.prototype, name),
  );
  CurrentUser()(ClassPolicyController.prototype, name, 0);
}
Roles(...ROLE_POLICIES.ADMIN_ONLY)(
  ClassPolicyController.prototype,
  'restricted',
  Object.getOwnPropertyDescriptor(
    ClassPolicyController.prototype,
    'restricted',
  ),
);
Roles(...ROLE_POLICIES.STUDENT_ONLY)(
  ClassPolicyController.prototype,
  'overridden',
  Object.getOwnPropertyDescriptor(
    ClassPolicyController.prototype,
    'overridden',
  ),
);

test('HTTP authentication + authorization and safe CurrentUser', async (t) => {
  const config = validateEnvironment({
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64'),
  });
  const users = new Map(
    Object.values(USER_ROLES).map((role) => [
      role,
      {
        ...safeUser(role),
        id: role,
        status: true,
        password: 'must-not-leak',
        passwordHash: 'must-not-leak',
        refreshTokenHash: 'must-not-leak',
      },
    ]),
  );
  const revoked = new Set();
  let reads = 0;
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => config],
      }),
      AuthModule,
    ],
    controllers: [ProtectedController, ClassPolicyController],
  })
    .overrideProvider(UsersRepository)
    .useValue({
      findById: async (id) => {
        reads++;
        return users.get(id) ?? null;
      },
    })
    .overrideProvider(AuthSessionRepository)
    .useValue({
      isActive: async (sid, sub) =>
        sid === `session-${sub}` && !revoked.has(sid),
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const jwt = app.get(JwtService);
  const token = (role) =>
    jwt.signAsync({ sub: role, role, sid: `session-${role}` });
  const request = async (route, bearer) => {
    const r = await fetch(base + '/api/' + route, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
    return { status: r.status, body: await r.json() };
  };

  await t.test(
    'missing, invalid and expired JWTs return 401 before role evaluation',
    async () => {
      for (const bearer of [
        null,
        'invalid',
        await jwt.signAsync(
          { sub: 'ADMIN', role: 'ADMIN', sid: 'session-ADMIN' },
          { expiresIn: -1 },
        ),
      ])
        assert.equal(
          (await request('authorization-test/admin', bearer)).status,
          401,
        );
    },
  );
  await t.test('role matrix is enforced at HTTP boundaries', async () => {
    for (const [route, allowed] of [
      ['admin', ['ADMIN']],
      ['cms', ['ADMIN', 'TEACHER']],
      ['student', ['STUDENT']],
      ['authenticated', ['ADMIN', 'TEACHER', 'STUDENT']],
    ]) {
      for (const role of Object.values(USER_ROLES))
        assert.equal(
          (await request('authorization-test/' + route, await token(role)))
            .status,
          allowed.includes(role) ? 200 : 403,
        );
    }
  });
  await t.test(
    'CurrentUser returns only safe fields without another database lookup',
    async () => {
      const bearer = await token('ADMIN');
      const before = reads;
      const r = await request('authorization-test/admin', bearer);
      assert.equal(reads, before + 1);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        id: 'ADMIN',
        fullName: 'Test User',
        email: 'user@example.test',
        role: 'ADMIN',
        isActive: true,
      });
    },
  );
  await t.test(
    'class-level policy and method-level overrides are enforced',
    async () => {
      assert.equal(
        (await request('class-policy-test/inherited', await token('TEACHER')))
          .status,
        200,
      );
      assert.equal(
        (await request('class-policy-test/restricted', await token('TEACHER')))
          .status,
        403,
      );
      assert.equal(
        (await request('class-policy-test/restricted', await token('ADMIN')))
          .status,
        200,
      );
      assert.equal(
        (await request('class-policy-test/overridden', await token('STUDENT')))
          .status,
        200,
      );
      assert.equal(
        (await request('class-policy-test/overridden', await token('ADMIN')))
          .status,
        403,
      );
    },
  );
  await t.test(
    'revoked sessions and inactive/deleted users return 401',
    async () => {
      const bearer = await token('ADMIN');
      revoked.add('session-ADMIN');
      assert.equal(
        (await request('authorization-test/admin', bearer)).status,
        401,
      );
      revoked.clear();
      users.get('ADMIN').status = false;
      assert.equal(
        (await request('authorization-test/admin', bearer)).status,
        401,
      );
      users.get('ADMIN').status = true;
      const saved = users.get('ADMIN');
      users.delete('ADMIN');
      assert.equal(
        (await request('authorization-test/admin', bearer)).status,
        401,
      );
      users.set('ADMIN', saved);
    },
  );
  await t.test(
    'current database role overrides stale JWT role and client-supplied roles',
    async () => {
      const bearer = await token('ADMIN');
      users.get('ADMIN').role = 'TEACHER';
      assert.equal(
        (
          await request(
            'authorization-test/admin?role=ADMIN&userId=ADMIN',
            bearer,
          )
        ).status,
        403,
      );
      assert.equal(
        (await request('authorization-test/cms', bearer)).status,
        200,
      );
      users.get('ADMIN').role = 'ADMIN';
      const oldStudent = await token('STUDENT');
      users.get('STUDENT').role = 'ADMIN';
      assert.equal(
        (await request('authorization-test/admin', oldStudent)).status,
        200,
      );
      users.get('STUDENT').role = 'STUDENT';
    },
  );
  await t.test(
    'Swagger records Bearer, role policies and 401/403 including method overrides',
    async () => {
      const docs = await (await fetch(base + '/api/docs-json')).json();
      const admin = docs.paths['/api/authorization-test/admin'].get;
      assert.deepEqual(admin.security, [{ bearer: [] }]);
      assert(admin.responses['401']);
      assert(admin.responses['403']);
      assert.deepEqual(admin['x-required-roles'], ['ADMIN']);
      assert.deepEqual(
        docs.paths['/api/authorization-test/cms'].get['x-required-roles'],
        ['ADMIN', 'TEACHER'],
      );
      assert.deepEqual(
        docs.paths['/api/class-policy-test/restricted'].get['x-required-roles'],
        ['ADMIN'],
      );
      assert.match(
        docs.paths['/api/class-policy-test/restricted'].get.responses['403']
          .description,
        /Required role: ADMIN\./,
      );
    },
  );
});
