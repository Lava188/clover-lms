function origin(value: unknown): string {
  const text = String(value).trim();
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== text) {
    throw new Error(
      'Configured origins must be exact HTTP(S) origins without paths or wildcards.',
    );
  }
  return text;
}

export function validateBaseEnvironment(config: Record<string, unknown>) {
  const port = Number(config.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid TCP port');
  const origins = String(
    config.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:5174',
  )
    .split(',')
    .map(origin);
  return {
    ...config,
    PORT: port,
    CORS_ORIGIN: origins.join(','),
    CORS_ORIGINS: origins,
  };
}

export function validateEnvironment(config: Record<string, unknown>) {
  const base = validateBaseEnvironment(config);
  const secret = config.JWT_ACCESS_SECRET;
  if (
    typeof secret !== 'string' ||
    Buffer.byteLength(secret) < 32 ||
    new Set(secret).size < 8 ||
    /change.?me|your.?secret|replace|^<.*>$/i.test(secret)
  ) {
    throw new Error(
      'JWT_ACCESS_SECRET must be a securely generated secret of at least 32 bytes, not a placeholder.',
    );
  }
  const lifetime = String(config.JWT_ACCESS_EXPIRES_IN ?? '15m');
  const match = /^([1-9]\d*)(s|m|h)?$/.exec(lifetime);
  const seconds = match
    ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] ?? 's'] ?? 0)
    : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new Error(
      'JWT_ACCESS_EXPIRES_IN must be 60–3600 seconds (for example 15m).',
    );
  }
  const issuer = String(config.JWT_ISSUER ?? 'clover-lms-api').trim();
  const audience = String(config.JWT_AUDIENCE ?? 'clover-lms').trim();
  if (!issuer || !audience)
    throw new Error('JWT_ISSUER and JWT_AUDIENCE must not be empty.');
  const production = config.NODE_ENV === 'production';
  const studentOrigin = origin(
    config.AUTH_STUDENT_ORIGIN ?? 'http://localhost:5173',
  );
  const adminOrigin = origin(
    config.AUTH_ADMIN_ORIGIN ?? 'http://localhost:5174',
  );
  const docsOrigin =
    config.AUTH_DOCS_ORIGIN === '' ||
    (production && config.AUTH_DOCS_ORIGIN === undefined)
      ? ''
      : origin(config.AUTH_DOCS_ORIGIN ?? 'http://localhost:3000');
  if (
    new Set([studentOrigin, adminOrigin, ...(docsOrigin ? [docsOrigin] : [])])
      .size !== (docsOrigin ? 3 : 2)
  ) {
    throw new Error(
      'Student, CMS and optional Swagger origins must be distinct.',
    );
  }
  const origins = [
    ...new Set([
      ...base.CORS_ORIGINS,
      studentOrigin,
      adminOrigin,
      ...(docsOrigin ? [docsOrigin] : []),
    ]),
  ];
  const secure = String(config.AUTH_COOKIE_SECURE ?? production);
  if (
    !['true', 'false'].includes(secure) ||
    (production && secure !== 'true')
  ) {
    throw new Error(
      'AUTH_COOKIE_SECURE must be true/false and must be true in production.',
    );
  }
  const sameSite = String(config.AUTH_COOKIE_SAME_SITE ?? 'lax');
  if (
    !['lax', 'strict', 'none'].includes(sameSite) ||
    (sameSite === 'none' && secure !== 'true')
  ) {
    throw new Error(
      'AUTH_COOKIE_SAME_SITE must be lax/strict/none; none requires Secure.',
    );
  }
  if (production && origins.some((value) => !value.startsWith('https://'))) {
    throw new Error('All allowed origins must use HTTPS in production.');
  }
  const cookieName = String(config.AUTH_COOKIE_NAME ?? 'clover_refresh');
  const cookiePath = String(config.AUTH_COOKIE_PATH ?? '/api/auth');
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(cookieName) ||
    !['/', '/api', '/api/auth'].includes(cookiePath) ||
    (cookieName.startsWith('__Secure-') && secure !== 'true') ||
    (cookieName.startsWith('__Host-') &&
      (secure !== 'true' || cookiePath !== '/'))
  ) {
    throw new Error(
      'Invalid refresh cookie name, path or security prefix configuration.',
    );
  }
  const refreshLifetime = String(config.AUTH_REFRESH_EXPIRES_IN ?? '7d');
  const refreshMatch = /^([1-9]\d*)(s|m|h|d)?$/.exec(refreshLifetime);
  const refreshSeconds = refreshMatch
    ? Number(refreshMatch[1]) *
      ({ s: 1, m: 60, h: 3600, d: 86400 }[refreshMatch[2] ?? 's'] ?? 0)
    : NaN;
  if (
    !Number.isSafeInteger(refreshSeconds) ||
    refreshSeconds < 60 ||
    refreshSeconds > 90 * 86400
  ) {
    throw new Error(
      'AUTH_REFRESH_EXPIRES_IN must be between 60 seconds and 90 days.',
    );
  }
  return {
    ...base,
    JWT_ACCESS_SECRET: secret,
    JWT_ACCESS_EXPIRES_IN: lifetime,
    JWT_ACCESS_EXPIRES_SECONDS: seconds,
    JWT_ISSUER: issuer,
    JWT_AUDIENCE: audience,
    CORS_ORIGINS: origins,
    AUTH_STUDENT_ORIGIN: studentOrigin,
    AUTH_ADMIN_ORIGIN: adminOrigin,
    AUTH_DOCS_ORIGIN: docsOrigin,
    AUTH_REFRESH_EXPIRES_IN: refreshLifetime,
    AUTH_REFRESH_EXPIRES_SECONDS: refreshSeconds,
    AUTH_COOKIE_NAME: cookieName,
    AUTH_COOKIE_PATH: cookiePath,
    AUTH_COOKIE_SECURE: secure === 'true',
    AUTH_COOKIE_SAME_SITE: sameSite,
  };
}
