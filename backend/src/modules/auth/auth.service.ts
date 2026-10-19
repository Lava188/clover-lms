import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { PasswordService } from '../users/password.service';
import { UsersRepository, type User } from '../users/users.repository';
import { AuthUserDto, LoginResponseDto } from './dto/auth-response.dto';
import {
  AuthSessionRepository,
  type AuthClient,
} from './auth-session.repository';
import { isRole } from '../../common/auth.types';

export interface SessionResult {
  body: LoginResponseDto;
  refreshToken: string;
  expiresAt: Date;
}

function safeUser(user: User): AuthUserDto {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    isActive: user.status,
  };
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  constructor(
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: AuthSessionRepository,
  ) {}

  async onModuleInit() {
    // Unknown email still performs a password verification, reducing enumeration.
    this.dummyHash = await this.passwords.hashPassword(
      randomBytes(32).toString('hex'),
    );
  }

  async login(
    email: string,
    password: string,
    client: AuthClient,
  ): Promise<SessionResult> {
    let user;
    try {
      user = await this.users.findCredentialsByEmail(email);
    } catch {
      throw new ServiceUnavailableException(
        'Authentication service unavailable.',
      );
    }
    const valid = await this.passwords.verifyPassword(
      password,
      user?.password ?? this.dummyHash,
    );
    if (!user || !valid || !user.status)
      throw new UnauthorizedException('Invalid email or password.');
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() +
        this.config.getOrThrow<number>('AUTH_REFRESH_EXPIRES_SECONDS') * 1000,
    );
    try {
      return await this.sessions.create(
        user.id,
        client,
        this.digest(refreshToken),
        expiresAt,
        async (session) => ({
          body: await this.issue(user, session.id),
          refreshToken,
          expiresAt,
        }),
      );
    } catch {
      throw new ServiceUnavailableException(
        'Authentication service unavailable.',
      );
    }
  }

  private async issue(
    user: User,
    sessionId: string,
  ): Promise<LoginResponseDto> {
    return {
      accessToken: await this.jwt.signAsync({
        sub: user.id,
        role: user.role,
        sid: sessionId,
      }),
      tokenType: 'Bearer',
      expiresIn: this.config.getOrThrow<number>('JWT_ACCESS_EXPIRES_SECONDS'),
      user: safeUser(user),
    };
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private isRefreshToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  }

  async refresh(raw: unknown, client: AuthClient): Promise<SessionResult> {
    if (!this.isRefreshToken(raw))
      throw new UnauthorizedException('Invalid or expired refresh session.');
    const hash = this.digest(raw);
    let result: SessionResult | null;
    try {
      result = await this.sessions.withToken(
        hash,
        client,
        async (record, tx) => {
          if (!record) return null;
          const { session, consumedAt } = record;
          if (session.revokedAt || session.expiresAt.getTime() <= Date.now())
            return null;
          if (consumedAt) {
            // Commit revocation BEFORE returning 401; throwing in this callback
            // would roll back the security action along with the transaction.
            await this.sessions.revoke(session.id, tx);
            return null;
          }
          const user = await this.users.findById(session.userId, tx);
          if (!user || !user.status) {
            await this.sessions.revoke(session.id, tx);
            return null;
          }
          const refreshToken = randomBytes(32).toString('base64url');
          await this.sessions.rotate(
            session.id,
            hash,
            this.digest(refreshToken),
            tx,
          );
          return {
            body: await this.issue(user, session.id),
            refreshToken,
            expiresAt: session.expiresAt,
          };
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Authentication service unavailable.',
      );
    }
    if (!result)
      throw new UnauthorizedException('Invalid or expired refresh session.');
    return result;
  }

  async logout(raw: unknown, client: AuthClient): Promise<void> {
    if (!this.isRefreshToken(raw)) return;
    try {
      await this.sessions.withToken(
        this.digest(raw),
        client,
        async (record, tx) => {
          if (record) await this.sessions.revoke(record.session.id, tx);
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Authentication service unavailable.',
      );
    }
  }

  async authenticate(token: string): Promise<AuthUserDto> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token);
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub.trim() ||
        typeof payload.sid !== 'string' ||
        !payload.sid.trim() ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp) ||
        typeof payload.iat !== 'number' ||
        !isRole(payload.role)
      ) {
        throw new Error('Invalid claims');
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
    let user;
    try {
      if (
        !(await this.sessions.isActive(
          payload.sid as string,
          payload.sub as string,
        ))
      ) {
        throw new UnauthorizedException('Invalid or expired access token.');
      }
      user = await this.users.findById(payload.sub as string);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException(
        'Authentication service unavailable.',
      );
    }
    if (!user || !user.status)
      throw new UnauthorizedException('Invalid or expired access token.');
    // Request context always uses current database role, not the token's role.
    return safeUser(user);
  }
}
