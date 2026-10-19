-- Review the target Neon branch before running through the migration runner.
-- Preserve TEXT, uniqueness and the non-empty check for supplied values.
ALTER TABLE public."User" ALTER COLUMN "phone" DROP NOT NULL;

COMMENT ON COLUMN public."User"."phone" IS 'Optional phone stored as text to preserve leading zeroes. NULL means not provided.';
