/* eslint-disable @typescript-eslint/no-require-imports */
// Node 24 runs this TypeScript CLI directly; Nest application code is compiled
// first so dependency-injection decorator metadata remains intact.
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { UsersModule } = require('../dist/modules/users/users.module');
const { validateBaseEnvironment } = require('../dist/config/environment');
const {
  UsersService,
  AdminAlreadyExistsError,
} = require('../dist/modules/users/users.service');
const { BadRequestException, ConflictException } = require('@nestjs/common');

async function runBootstrapAdmin() {
  if (process.argv.length > 2) {
    console.error(
      'Bootstrap failed: command-line arguments are not accepted. Use BOOTSTRAP_ADMIN_* environment variables.',
    );
    process.exitCode = 1;
    return;
  }
  const input = {
    fullName: process.env.BOOTSTRAP_ADMIN_NAME,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    phone: process.env.BOOTSTRAP_ADMIN_PHONE || null,
  };
  if (!input.fullName || !input.email || !input.password) {
    console.error(
      'Bootstrap failed: set BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD. Phone is optional.',
    );
    process.exitCode = 1;
    return;
  }
  // Do not retain bootstrap secrets in process.env while loading the app.
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  let app;
  try {
    // CLI needs database configuration, not JWT or HTTP authentication modules.
    class BootstrapModule {}
    Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateBaseEnvironment,
        }),
        UsersModule,
      ],
    })(BootstrapModule);
    app = await NestFactory.createApplicationContext(BootstrapModule, {
      logger: false,
      abortOnError: false,
    });
    await app.get(UsersService).bootstrapFirstAdmin(input);
    console.log('Initial ADMIN account created successfully.');
  } catch (error) {
    if (error instanceof AdminAlreadyExistsError) {
      console.error(
        'Bootstrap stopped: an ADMIN account already exists (including disabled accounts). No account was created or modified.',
      );
    } else if (error instanceof BadRequestException) {
      console.error(
        'Bootstrap failed: invalid name, email, phone or password. Password must have at least 12 characters and at most 1024 UTF-8 bytes.',
      );
    } else if (error instanceof ConflictException) {
      console.error(
        'Bootstrap failed: email or phone is already in use. Existing accounts will not be promoted or overwritten.',
      );
    } else {
      console.error(
        'Bootstrap failed: check database connectivity, required migrations and privileges. Credentials and database error details have been omitted.',
      );
    }
    process.exitCode = 1;
  } finally {
    input.password = undefined;
    if (app) await app.close();
  }
}

runBootstrapAdmin().catch(() => {
  console.error(
    'Bootstrap failed during cleanup. Credentials and error details have been omitted.',
  );
  process.exitCode = 1;
});
