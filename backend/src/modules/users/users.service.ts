import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import { PasswordService } from './password.service';
import {
  CreateUserRecord,
  DuplicateUserError,
  Role,
  UsersRepository,
} from './users.repository';
import type { PoolClient } from 'pg';
import { isRole, USER_ROLES } from '../../common/auth.types';

export interface CreateUserInput {
  fullName: string;
  email: string;
  phone?: string | null;
  password: string;
  role?: Role;
  status?: boolean;
}
export type BootstrapAdminInput = Pick<
  CreateUserInput,
  'fullName' | 'email' | 'password' | 'phone'
>;

export class AdminAlreadyExistsError extends ConflictException {
  constructor() {
    super(
      'An ADMIN account already exists. No account was created or modified.',
    );
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
  ) {}

  findById(id: string) {
    return this.users.findById(id);
  }
  findByEmail(email: string) {
    return this.users.findByEmail(email);
  }

  // Internal API only. This is not a public registration/role assignment endpoint.
  async createUser(input: CreateUserInput) {
    return this.insertUser(await this.prepareUser(input));
  }

  async bootstrapFirstAdmin(input: BootstrapAdminInput) {
    // Never accept a caller-controlled role or account status for this workflow.
    const record = await this.prepareUser({
      fullName: input.fullName,
      email: input.email,
      password: input.password,
      phone: input.phone,
      role: USER_ROLES.ADMIN,
      status: true,
    });
    return this.users.withBootstrapLock(async (client) => {
      if (await this.users.hasAdmin(client))
        throw new AdminAlreadyExistsError();
      return this.insertUser(record, client);
    });
  }

  private async prepareUser(input: CreateUserInput): Promise<CreateUserRecord> {
    if (typeof input.fullName !== 'string' || typeof input.email !== 'string') {
      throw new BadRequestException(
        'A full name and valid email are required.',
      );
    }
    const fullName = input.fullName?.trim();
    const email = input.email?.trim().toLowerCase();
    if (!fullName || !email || !isEmail(email)) {
      throw new BadRequestException(
        'A full name and valid email are required.',
      );
    }
    if (input.phone != null && typeof input.phone !== 'string') {
      throw new BadRequestException('Phone must be a string or null.');
    }
    const phone = input.phone?.trim() || null;
    const role = input.role ?? USER_ROLES.STUDENT;
    if (!isRole(role)) {
      throw new BadRequestException('Invalid user role.');
    }
    if (input.status !== undefined && typeof input.status !== 'boolean') {
      throw new BadRequestException('Status must be a boolean.');
    }
    const passwordHash = await this.passwords.hashPassword(input.password);
    return {
      fullName,
      email,
      phone,
      passwordHash,
      role,
      status: input.status ?? true,
    };
  }

  private async insertUser(record: CreateUserRecord, client?: PoolClient) {
    try {
      return await this.users.createUser(record, client);
    } catch (error) {
      if (error instanceof DuplicateUserError)
        throw new ConflictException(error.message);
      throw error;
    }
  }

  async updatePassword(id: string, password: string) {
    const passwordHash = await this.passwords.hashPassword(password);
    const user = await this.users.updatePassword(id, passwordHash);
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }
}
