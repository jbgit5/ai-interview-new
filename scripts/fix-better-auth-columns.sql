-- Fix better-auth schema to use exact camelCase column names expected by adapters.
-- Safe to run multiple times.

DO $$
BEGIN
  -- Add missing role column used by better-auth additionalFields
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'role'
  ) THEN
    ALTER TABLE "user" ADD COLUMN role TEXT NOT NULL DEFAULT 'recruiter';
  END IF;

  -- user table
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'emailverified'
  ) THEN
    ALTER TABLE "user" RENAME COLUMN emailverified TO "emailVerified";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'createdat'
  ) THEN
    ALTER TABLE "user" RENAME COLUMN createdat TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'updatedat'
  ) THEN
    ALTER TABLE "user" RENAME COLUMN updatedat TO "updatedAt";
  END IF;

  -- session table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'token'
  ) THEN
    ALTER TABLE "session" ADD COLUMN token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_token ON "session" (token);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'userid'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN userid TO "userId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'expiresat'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN expiresat TO "expiresAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'ipaddress'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN ipaddress TO "ipAddress";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'useragent'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN useragent TO "userAgent";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'createdat'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN createdat TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'updatedat'
  ) THEN
    ALTER TABLE "session" RENAME COLUMN updatedat TO "updatedAt";
  END IF;

  -- account table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'idToken'
  ) THEN
    ALTER TABLE "account" ADD COLUMN "idToken" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'accessTokenExpiresAt'
  ) THEN
    ALTER TABLE "account" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'refreshTokenExpiresAt'
  ) THEN
    ALTER TABLE "account" ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'scope'
  ) THEN
    ALTER TABLE "account" ADD COLUMN scope TEXT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'userid'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN userid TO "userId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'accountid'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN accountid TO "accountId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'providerid'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN providerid TO "providerId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'accesstoken'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN accesstoken TO "accessToken";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'refreshtoken'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN refreshtoken TO "refreshToken";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'expiresat'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN expiresat TO "expiresAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'createdat'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN createdat TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'updatedat'
  ) THEN
    ALTER TABLE "account" RENAME COLUMN updatedat TO "updatedAt";
  END IF;

  -- verification table
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification' AND column_name = 'expiresat'
  ) THEN
    ALTER TABLE "verification" RENAME COLUMN expiresat TO "expiresAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification' AND column_name = 'createdat'
  ) THEN
    ALTER TABLE "verification" RENAME COLUMN createdat TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification' AND column_name = 'updatedat'
  ) THEN
    ALTER TABLE "verification" RENAME COLUMN updatedat TO "updatedAt";
  END IF;
END $$;
