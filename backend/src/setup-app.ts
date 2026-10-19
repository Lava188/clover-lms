import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

// Shared by production startup and HTTP integration tests.
export function setupApp(app: INestApplication) {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.getOrThrow<string[]>('CORS_ORIGINS'),
    credentials: true,
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Clover LMS API')
      .setVersion('1.0')
      .addBearerAuth()
      .addCookieAuth(
        `${config.getOrThrow<string>('AUTH_COOKIE_NAME')}_student`,
        {
          type: 'apiKey',
          in: 'cookie',
          description:
            'HttpOnly refresh cookie. CMS uses the same prefix with _admin. Origin selects the client; never pass a refresh token in JSON or a URL.',
        },
        'refreshCookie',
      )
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: false },
  });
}
