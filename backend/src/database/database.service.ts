import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool?: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly config: ConfigService) {}

  private getPool(): Pool {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString?.trim()) {
      throw new ServiceUnavailableException('Database is not configured');
    }
    if (!this.pool) {
      this.pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
        statement_timeout: 10000,
      });
      // Do not log connection details or raw errors that may contain secrets.
      this.pool.on('error', () => {
        this.logger.error('An idle database connection failed');
      });
    }
    return this.pool;
  }

  // Pass user input through $1, $2... parameters, never string interpolation.
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters: unknown[] = [],
  ) {
    return this.getPool().query<Row>(sql, parameters);
  }

  async checkConnection(): Promise<void> {
    try {
      await this.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException(
        'Database is not configured or unavailable',
      );
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
