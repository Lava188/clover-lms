import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { UsersRepository } from './users.repository';
import { PasswordService } from './password.service';

@Module({
  imports: [DatabaseModule],
  providers: [UsersRepository, PasswordService],
  exports: [UsersRepository, PasswordService],
})
export class UsersModule {}
