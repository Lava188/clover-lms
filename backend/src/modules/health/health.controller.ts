import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}
  @Get()
  health() {
    return { status: 'ok', message: 'IELTS LMS API is running' };
  }
  @Get('database')
  async database() {
    await this.databaseService.checkConnection();
    return { status: 'ok', database: 'connected' };
  }
}
