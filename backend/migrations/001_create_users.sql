CREATE TYPE public."Role" AS ENUM ('ADMIN', 'TEACHER', 'STUDENT');

CREATE TABLE public."User" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "fullName" TEXT NOT NULL,
  "phone" INTEGER UNIQUE NOT NULL,
  "email" TEXT UNIQUE NOT NULL,
  "password" TEXT NOT NULL,
  "role" public."Role" NOT NULL DEFAULT 'STUDENT',
  "status" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN public."User"."password" IS 'Store password hashes only; never plaintext passwords.';

CREATE FUNCTION public.set_user_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_updated_at
BEFORE UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();
