-- The migration runner owns the transaction. Never run with CASCADE.
LOCK TABLE public."User", public."Admin", public."Student" IN ACCESS EXCLUSIVE MODE;

-- Refuse to discard any legacy record missing from or different to User.
-- Differences must be reconciled explicitly before retiring the source tables.
DO $$
BEGIN
  IF EXISTS (
    SELECT "id", "fullName", "phone"::text, lower(trim("email")), "password",
           "role", "status", "createdAt", "updatedAt"
    FROM public."Admin"
    UNION ALL
    SELECT "id", "fullName", "phone"::text, lower(trim("email")), "password",
           "role", "status", "createdAt", "updatedAt"
    FROM public."Student"
    EXCEPT
    SELECT "id", "fullName", "phone", "email", "password",
           "role", "status", "createdAt", "updatedAt"
    FROM public."User"
  ) THEN
    RAISE EXCEPTION 'Legacy accounts differ from User. Reconcile all account data before dropping legacy tables.';
  END IF;
END;
$$;

-- Shared names, email, phone, credentials and account status stay in User.
-- Optional profile details can be extended through later migrations.
CREATE TABLE public."StudentProfile" (
  "userId" TEXT PRIMARY KEY REFERENCES public."User" ("id") ON DELETE RESTRICT,
  "studentCode" TEXT UNIQUE CHECK (length(trim("studentCode")) > 0),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."StaffProfile" (
  "userId" TEXT PRIMARY KEY REFERENCES public."User" ("id") ON DELETE RESTRICT,
  "staffCode" TEXT UNIQUE CHECK (length(trim("staffCode")) > 0),
  "staffType" TEXT NOT NULL CHECK ("staffType" IN ('ADMIN', 'TEACHER', 'ASSISTANT')),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE public."StudentProfile" IS 'One optional learning profile per STUDENT account. Account information belongs to User.';
COMMENT ON TABLE public."StaffProfile" IS 'One optional personnel profile per ADMIN/TEACHER account. ASSISTANT is a personnel type, not a new authorization role.';
COMMENT ON COLUMN public."StaffProfile"."staffType" IS 'Personnel classification only. API authorization uses User.role and resource assignments.';

INSERT INTO public."StudentProfile" ("userId")
SELECT "id" FROM public."User" WHERE "role" = 'STUDENT';

INSERT INTO public."StaffProfile" ("userId", "staffType")
SELECT "id", "role"::text FROM public."User" WHERE "role" IN ('ADMIN', 'TEACHER');

CREATE TRIGGER student_profile_updated_at
BEFORE UPDATE ON public."StudentProfile"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();

CREATE TRIGGER staff_profile_updated_at
BEFORE UPDATE ON public."StaffProfile"
FOR EACH ROW EXECUTE FUNCTION public.set_user_updated_at();

-- External dependencies block deletion and roll back the entire migration.
DROP TABLE public."Admin" RESTRICT;
DROP TABLE public."Student" RESTRICT;
