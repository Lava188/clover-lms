import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { AuthClient } from './auth-session.repository';

@Injectable()
export class RefreshCookieService {
  constructor(private readonly config: ConfigService) {}

  client(request: Request): AuthClient {
    const origin = request.headers.origin;
    // Origin is a browser-controlled header; no Referer/Host/X-Forwarded-* fallback.
    // Reject missing/null Origin, including same-origin calls without the header.
    if (
      !origin ||
      !this.config.getOrThrow<string[]>('CORS_ORIGINS').includes(origin)
    ) {
      throw new ForbiddenException('A trusted Origin header is required.');
    }
    if (origin === this.config.getOrThrow<string>('AUTH_STUDENT_ORIGIN'))
      return 'student';
    if (origin === this.config.getOrThrow<string>('AUTH_ADMIN_ORIGIN'))
      return 'admin';
    if (origin === this.config.get<string>('AUTH_DOCS_ORIGIN'))
      return 'student';
    throw new ForbiddenException(
      'Origin is not configured for an authentication client.',
    );
  }

  name(client: AuthClient) {
    return `${this.config.getOrThrow<string>('AUTH_COOKIE_NAME')}_${client}`;
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.getOrThrow<boolean>('AUTH_COOKIE_SECURE'),
      sameSite: this.config.getOrThrow<'lax' | 'strict' | 'none'>(
        'AUTH_COOKIE_SAME_SITE',
      ),
      path: this.config.getOrThrow<string>('AUTH_COOKIE_PATH'),
    };
  }

  read(request: Request, client: AuthClient): unknown {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    return cookies?.[this.name(client)];
  }

  set(response: Response, client: AuthClient, token: string, expiresAt: Date) {
    response.cookie(this.name(client), token, {
      ...this.options(),
      maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
    });
  }

  clear(response: Response, client: AuthClient) {
    response.clearCookie(this.name(client), this.options());
  }
}
