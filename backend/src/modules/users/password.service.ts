import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    if (password.length < 12 || Buffer.byteLength(password) > 1024) {
      throw new Error(
        'Password must contain at least 12 characters and at most 1024 bytes.',
      );
    }
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    if (Buffer.byteLength(password) > 1024) return false;
    const match =
      /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
    if (!match) return false;
    const actual = await derive(password, Buffer.from(match[1], 'hex'));
    return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
  }
}
