import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
@Controller('health')
export class AppController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  health() {
    return { status: 'ok', message: 'IELTS LMS API is running' };
  }
  @Get('database')
  async database() {
    await this.prisma.checkConnection();
    return { status: 'ok', database: 'connected' };
  }
}
