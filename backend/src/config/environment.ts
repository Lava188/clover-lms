export function validateEnvironment(config: Record<string, unknown>) {
  const port = Number(config.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid TCP port');
  const origin = String(config.CORS_ORIGIN ?? 'http://localhost:5173');
  if (!['http:', 'https:'].includes(new URL(origin).protocol))
    throw new Error('CORS_ORIGIN must be an HTTP origin');
  return { ...config, PORT: port, CORS_ORIGIN: origin };
}
