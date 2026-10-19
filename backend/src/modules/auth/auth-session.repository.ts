import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

export type AuthClient = 'student' | 'admin';
export interface AuthSession {
  id: string;
  userId: string;
  client: AuthClient;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface LockedRefresh {
  session: AuthSession;
  consumedAt: Date | null;
}

@Injectable()
export class AuthSessionRepository {
  constructor(private readonly database: DatabaseService) {}

  async create<T>(
    userId: string,
    client: AuthClient,
    hash: string,
    expiresAt: Date,
    issue: (session: AuthSession) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query<AuthSession>(
        `INSERT INTO public."AuthSession" ("userId", "client", "expiresAt")
         VALUES ($1, $2, $3) RETURNING *`,
        [userId, client, expiresAt],
      );
      await tx.query(
        'INSERT INTO public."AuthRefreshToken" ("hash", "sessionId") VALUES ($1, $2)',
        [hash, rows[0].id],
      );
      return issue(rows[0]);
    });
  }

  async withToken<T>(
    hash: string,
    client: AuthClient,
    work: (record: LockedRefresh | null, tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const token = await tx.query<{ sessionId: string }>(
        'SELECT "sessionId" FROM public."AuthRefreshToken" WHERE "hash" = $1',
        [hash],
      );
      if (!token.rows[0]) return work(null, tx);
      const session = await tx.query<AuthSession>(
        'SELECT * FROM public."AuthSession" WHERE "id" = $1 AND "client" = $2 FOR UPDATE',
        [token.rows[0].sessionId, client],
      );
      if (!session.rows[0]) return work(null, tx);
      // Read consumption AFTER acquiring the parent lock: a waiting request
      // must observe a rotation committed by the previous transaction.
      const current = await tx.query<{ consumedAt: Date | null }>(
        'SELECT "consumedAt" FROM public."AuthRefreshToken" WHERE "hash" = $1',
        [hash],
      );
      return work(
        current.rows[0]
          ? { session: session.rows[0], consumedAt: current.rows[0].consumedAt }
          : null,
        tx,
      );
    });
  }

  async rotate(id: string, oldHash: string, newHash: string, tx: PoolClient) {
    await tx.query(
      'UPDATE public."AuthRefreshToken" SET "consumedAt" = clock_timestamp() WHERE "hash" = $1',
      [oldHash],
    );
    await tx.query(
      'INSERT INTO public."AuthRefreshToken" ("hash", "sessionId") VALUES ($1, $2)',
      [newHash, id],
    );
    await tx.query(
      'UPDATE public."AuthSession" SET "lastUsedAt" = clock_timestamp() WHERE "id" = $1',
      [id],
    );
  }

  async revoke(id: string, tx: PoolClient) {
    await tx.query(
      'UPDATE public."AuthSession" SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()) WHERE "id" = $1',
      [id],
    );
  }

  async isActive(id: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM public."AuthSession" WHERE "id" = $1 AND "userId" = $2
       AND "revokedAt" IS NULL AND "expiresAt" > clock_timestamp()`,
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
