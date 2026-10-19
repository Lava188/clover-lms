import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UsersRepository } from './modules/users/users.repository';
import { PasswordService } from './modules/users/password.service';

async function bootstrapAdmin() {
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const phone = process.env.BOOTSTRAP_ADMIN_PHONE?.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (
    !fullName ||
    !phone ||
    !email ||
    !password ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error(
      'Set valid BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_PHONE, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.',
    );
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const hash = await app.get(PasswordService).hash(password);
    await app
      .get(UsersRepository)
      .bootstrapAdmin({ fullName, phone, email, password: hash });
    console.log('Initial administrator created successfully.');
  } finally {
    await app.close();
  }
}

bootstrapAdmin().catch(() => {
  console.error(
    'Admin bootstrap failed. Check the required environment variables, password length (12+ characters), database migration, duplicate email/phone, and whether an administrator already exists. No credentials have been logged.',
  );
  process.exitCode = 1;
});
