import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export type Role = 'ADMIN' | 'TEACHER' | 'STUDENT';
export interface User {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  role: Role;
  status: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export interface Credentials extends User {
  password: string;
}
export interface NewAdmin {
  fullName: string;
  phone: string;
  email: string;
  password: string;
}
const publicColumns =
  '"id", "fullName", "phone", "email", "role", "status", "createdAt", "updatedAt"';

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.database.query<User>(
      `SELECT ${publicColumns} FROM public."User" WHERE "id" = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  // For authentication only: never serialize this result into an API response.
  async findCredentialsByEmail(email: string): Promise<Credentials | null> {
    const result = await this.database.query<Credentials>(
      `SELECT ${publicColumns}, "password" FROM public."User" WHERE lower("email") = $1`,
      [email.trim().toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  async bootstrapAdmin(input: NewAdmin): Promise<User> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(742019, 2)');
      const existing = await client.query(
        'SELECT 1 FROM public."User" WHERE "role" = $1 LIMIT 1',
        ['ADMIN'],
      );
      if (existing.rowCount)
        throw new Error(
          'An administrator already exists. Bootstrap is disabled.',
        );
      const result = await client.query<User>(
        `INSERT INTO public."User" ("fullName", "phone", "email", "password", "role")
         VALUES ($1, $2, $3, $4, 'ADMIN') RETURNING ${publicColumns}`,
        [input.fullName, input.phone, input.email, input.password],
      );
      return result.rows[0];
    });
  }
}
