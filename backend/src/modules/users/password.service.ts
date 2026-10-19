import { BadRequestException, Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    if (
      typeof password !== 'string' ||
      password.length < 12 ||
      Buffer.byteLength(password) > 1024
    ) {
      throw new BadRequestException(
        'Password must contain at least 12 characters and at most 1024 bytes.',
      );
    }
    return hash(password, {
      type: argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    });
  }

  async verifyPassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    if (
      typeof password !== 'string' ||
      Buffer.byteLength(password) > 1024 ||
      typeof passwordHash !== 'string' ||
      !passwordHash.startsWith('$argon2id$')
    )
      return false;
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
