-- Review and run manually on a dedicated Neon development branch only.
-- For a NEW database only; inspect existing tables before applying SQL.
BEGIN;
CREATE TYPE "Role" AS ENUM ('ADMIN', 'TEACHER', 'STUDENT');
CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'STUDENT',
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION set_user_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_updated_at
BEFORE UPDATE ON "User"
FOR EACH ROW EXECUTE FUNCTION set_user_updated_at();
COMMIT;
