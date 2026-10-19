-- Run with the migration runner. Preserve source tables for reconciliation.
LOCK TABLE public."Admin", public."Student" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public."User" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "fullName" TEXT NOT NULL,
  "phone" TEXT UNIQUE NOT NULL CHECK (length(trim("phone")) > 0),
  "email" TEXT NOT NULL CHECK (length(trim("email")) > 0),
  "password" TEXT NOT NULL,
  "role" public."Role" NOT NULL DEFAULT 'STUDENT',
  "status" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX user_email_unique ON public."User" (lower("email"));

-- Duplicate IDs, phones or case-insensitive emails abort the entire transaction.
-- Integer phone values cannot recover leading zeroes already lost previously.
INSERT INTO public."User"
SELECT "id", "fullName", "phone"::text, lower(trim("email")), "password",
       "role", "status", "createdAt", "updatedAt"
FROM public."Admin"
UNION ALL
SELECT "id", "fullName", "phone"::text, lower(trim("email")), "password",
       "role", "status", "createdAt", "updatedAt"
FROM public."Student";

COMMENT ON COLUMN public."User"."password" IS 'Password hash only; never store plaintext.';
COMMENT ON TABLE public."Admin" IS 'Legacy snapshot after migration 003. Do not use for authentication or writes.';
COMMENT ON TABLE public."Student" IS 'Legacy snapshot after migration 003. Do not use for authentication or writes.';

CREATE TRIGGER user_updated_at BEFORE UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();
