import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { validateEnvironment } from './config/environment';
import { UsersModule } from './modules/users/users.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    HealthModule,
    UsersModule,
  ],
})
export class AppModule {}
