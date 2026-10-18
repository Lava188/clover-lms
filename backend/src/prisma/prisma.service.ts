import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private client?: PrismaClient;
  constructor(private readonly config: ConfigService) {}
  getClient(): PrismaClient {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString)
      throw new ServiceUnavailableException('Database is not configured');
    this.client ??= new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      }),
    });
    return this.client;
  }
  async checkConnection(): Promise<void> {
    try {
      await this.getClient().$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException(
        'Database is not configured or unavailable',
      );
    }
  }
  async onModuleDestroy() {
    await this.client?.$disconnect();
  }
}
