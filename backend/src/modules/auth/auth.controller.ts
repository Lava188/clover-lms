import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  Header,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiHeader,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { AuthUserDto, LoginResponseDto } from './dto/auth-response.dto';
import { RefreshCookieService } from './refresh-cookie.service';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth.types';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: RefreshCookieService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Origin',
    required: true,
    description:
      'Configured Student/CMS origin; chooses a separate host-only refresh cookie for that client',
  })
  @ApiForbiddenResponse({ description: 'Missing or untrusted Origin' })
  @ApiOperation({ summary: 'Authenticate an active ADMIN, TEACHER or STUDENT' })
  @ApiOkResponse({
    type: LoginResponseDto,
    headers: {
      'Set-Cookie': {
        description:
          'Host-only HttpOnly refresh cookie for the Origin client. Never included in JSON.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Missing/invalid fields or unexpected request fields',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials or inactive account (generic error)',
  })
  @ApiResponse({
    status: 429,
    description: 'More than 5 login attempts per IP in 60 seconds',
  })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable',
  })
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const client = this.cookies.client(request);
    const result = await this.auth.login(input.email, input.password, client);
    this.cookies.set(response, client, result.refreshToken, result.expiresAt);
    return result.body;
  }

  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary: 'Rotate the HttpOnly refresh token; no access token required',
  })
  @ApiCookieAuth('refreshCookie')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiOkResponse({
    type: LoginResponseDto,
    headers: {
      'Set-Cookie': {
        description:
          'Rotated HttpOnly refresh cookie, with Max-Age limited to remaining absolute session lifetime.',
        schema: { type: 'string' },
      },
    },
    description:
      'New access JWT and rotated HttpOnly cookie; absolute session expiry is unchanged',
  })
  @ApiUnauthorizedResponse({
    description:
      'Missing/invalid/expired/revoked/replayed refresh token; cookie is cleared',
  })
  @ApiForbiddenResponse({ description: 'Missing or untrusted Origin' })
  @ApiResponse({ status: 429, description: 'Too many refresh attempts per IP' })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable',
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const client = this.cookies.client(request);
    try {
      const result = await this.auth.refresh(
        this.cookies.read(request, client),
        client,
      );
      this.cookies.set(response, client, result.refreshToken, result.expiresAt);
      return result.body;
    } catch (error) {
      if (error instanceof UnauthorizedException)
        this.cookies.clear(response, client);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Revoke only this refresh session and clear its cookie; idempotent, no access JWT required',
  })
  @ApiCookieAuth('refreshCookie')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiNoContentResponse({
    headers: {
      'Set-Cookie': {
        description:
          'Clear the Origin client refresh cookie with matching security/path attributes.',
        schema: { type: 'string' },
      },
    },
    description:
      'Cookie cleared; any identified session revoked, including its access JWTs',
  })
  @ApiForbiddenResponse({ description: 'Missing or untrusted Origin' })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable',
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const client = this.cookies.client(request);
    await this.auth.logout(this.cookies.read(request, client), client);
    this.cookies.clear(response, client);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get current account information from the database',
  })
  @ApiOkResponse({ type: AuthUserDto })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired token or deleted/inactive account',
  })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
