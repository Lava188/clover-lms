import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { PoolClient } from 'pg';

import { USER_ROLES, type Role } from '../../common/auth.types';
export type { Role } from '../../common/auth.types';
export interface User {
  id: string;
  fullName: string;
  phone: string | null;
  email: string;
  role: Role;
  status: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export interface Credentials extends User {
  password: string;
}
const publicColumns =
  '"id", "fullName", "phone", "email", "role", "status", "createdAt", "updatedAt"';

export interface CreateUserRecord {
  fullName: string;
  phone: string | null;
  email: string;
  passwordHash: string;
  role: Role;
  status: boolean;
}

export class DuplicateUserError extends Error {
  constructor(public readonly field: 'email' | 'phone') {
    super(`A user with this ${field} already exists.`);
  }
}

// Explicit allowlist protects public results even if a query over-selects fields.
export function toPublicUser(user: User): User {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  async findById(id: string, client?: PoolClient): Promise<User | null> {
    const query = (sql: string, values: unknown[]) =>
      client
        ? client.query<User>(sql, values)
        : this.database.query<User>(sql, values);
    const result = await query(
      `SELECT ${publicColumns} FROM public."User" WHERE "id" = $1`,
      [id],
    );
    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.database.query<User>(
      `SELECT ${publicColumns} FROM public."User" WHERE lower("email") = $1`,
      [email.trim().toLowerCase()],
    );
    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  async createUser(
    input: CreateUserRecord,
    client?: PoolClient,
  ): Promise<User> {
    try {
      const query = (sql: string, values: unknown[]) =>
        client
          ? client.query<User>(sql, values)
          : this.database.query<User>(sql, values);
      const result = await query(
        `INSERT INTO public."User" ("fullName", "email", "phone", "password", "role", "status")
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${publicColumns}`,
        [
          input.fullName,
          input.email.trim().toLowerCase(),
          input.phone,
          input.passwordHash,
          input.role,
          input.status,
        ],
      );
      return toPublicUser(result.rows[0]);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (
        failure.code === '23505' &&
        failure.constraint === 'user_email_unique'
      ) {
        throw new DuplicateUserError('email');
      }
      if (failure.code === '23505' && failure.constraint === 'User_phone_key') {
        throw new DuplicateUserError('phone');
      }
      throw error;
    }
  }

  async updatePassword(id: string, passwordHash: string): Promise<User | null> {
    const result = await this.database.query<User>(
      `UPDATE public."User" SET "password" = $2 WHERE "id" = $1 RETURNING ${publicColumns}`,
      [id, passwordHash],
    );
    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  // For authentication only: never serialize this result into an API response.
  async findCredentialsByEmail(email: string): Promise<Credentials | null> {
    const result = await this.database.query<Credentials>(
      `SELECT ${publicColumns}, "password" FROM public."User" WHERE lower("email") = $1`,
      [email.trim().toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  async withBootstrapLock<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      // Ensure a waiter sees the committed ADMIN after acquiring the lock.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(742019, 2)');
      // Also serialize with ordinary User writes, not only other CLI processes.
      await client.query(
        'LOCK TABLE public."User" IN SHARE ROW EXCLUSIVE MODE',
      );
      return work(client);
    });
  }

  async hasAdmin(client: PoolClient): Promise<boolean> {
    const result = await client.query(
      'SELECT 1 FROM public."User" WHERE "role" = $1 LIMIT 1',
      [USER_ROLES.ADMIN],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
