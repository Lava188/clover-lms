-- Run through npm run db:migrate, which owns the transaction.
-- Admin represents CMS accounts: both ADMIN and TEACHER.
-- Preserve account IDs and password hashes when moving existing users.
-- DROP TABLE uses RESTRICT: existing foreign keys block the migration safely.
LOCK TABLE public."User" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public."Admin" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "fullName" TEXT NOT NULL,
  "phone" INTEGER UNIQUE NOT NULL,
  "email" TEXT UNIQUE NOT NULL,
  "password" TEXT NOT NULL,
  "role" public."Role" NOT NULL DEFAULT 'TEACHER',
  "status" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT admin_role_check CHECK ("role" IN ('ADMIN', 'TEACHER'))
);

CREATE TABLE public."Student" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "fullName" TEXT NOT NULL,
  "phone" INTEGER UNIQUE NOT NULL,
  "email" TEXT UNIQUE NOT NULL,
  "password" TEXT NOT NULL,
  "role" public."Role" NOT NULL DEFAULT 'STUDENT',
  "status" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT student_role_check CHECK ("role" = 'STUDENT')
);

COMMENT ON TABLE public."Admin" IS 'CMS accounts for ADMIN and TEACHER roles. Authorization must be enforced by the backend.';
COMMENT ON TABLE public."Student" IS 'Student accounts for the learning application.';
COMMENT ON COLUMN public."Admin"."password" IS 'Store password hashes only; never plaintext passwords.';
COMMENT ON COLUMN public."Student"."password" IS 'Store password hashes only; never plaintext passwords.';

INSERT INTO public."Admin" (
  "id", "fullName", "phone", "email", "password", "role", "status", "createdAt", "updatedAt"
)
SELECT "id", "fullName", "phone", "email", "password", "role", "status", "createdAt", "updatedAt"
FROM public."User"
WHERE "role" IN ('ADMIN', 'TEACHER');

INSERT INTO public."Student" (
  "id", "fullName", "phone", "email", "password", "role", "status", "createdAt", "updatedAt"
)
SELECT "id", "fullName", "phone", "email", "password", "role", "status", "createdAt", "updatedAt"
FROM public."User"
WHERE "role" = 'STUDENT';

CREATE TRIGGER admin_updated_at
BEFORE UPDATE ON public."Admin"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();

CREATE TRIGGER student_updated_at
BEFORE UPDATE ON public."Student"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();

-- Only remove the original table after all accounts have been copied.
DROP TABLE public."User" RESTRICT;
