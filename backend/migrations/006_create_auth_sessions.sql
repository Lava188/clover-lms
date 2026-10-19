-- One row per independent login; refresh-token history belongs to that session.
CREATE TABLE public."AuthSession" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL REFERENCES public."User" ("id") ON DELETE CASCADE,
  "client" TEXT NOT NULL CHECK ("client" IN ('student', 'admin')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "lastUsedAt" TIMESTAMPTZ,
  CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX auth_session_user ON public."AuthSession" ("userId");
CREATE INDEX auth_session_expiration ON public."AuthSession" ("expiresAt");

CREATE TABLE public."AuthRefreshToken" (
  "hash" TEXT PRIMARY KEY CHECK ("hash" ~ '^[a-f0-9]{64}$'),
  "sessionId" TEXT NOT NULL REFERENCES public."AuthSession" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMPTZ
);
CREATE INDEX auth_refresh_token_session ON public."AuthRefreshToken" ("sessionId");
CREATE UNIQUE INDEX auth_refresh_one_current ON public."AuthRefreshToken" ("sessionId")
  WHERE "consumedAt" IS NULL;
COMMENT ON COLUMN public."AuthRefreshToken"."hash" IS 'SHA-256 digest only. Never persist raw refresh tokens.';
COMMENT ON TABLE public."AuthRefreshToken" IS 'Keep consumed digests until the parent session is deleted to detect replay without revoking unrelated logins.';
