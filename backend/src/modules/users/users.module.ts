import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { UsersRepository } from './users.repository';
import { PasswordService } from './password.service';
import { UsersService } from './users.service';

@Module({
  imports: [DatabaseModule],
  providers: [UsersRepository, PasswordService, UsersService],
  exports: [UsersRepository, PasswordService, UsersService],
})
export class UsersModule {}
