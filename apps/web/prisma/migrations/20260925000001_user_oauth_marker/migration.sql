-- Exact OAuth-linked marker on users. The app uses JWT sessions and has no
-- Account table, so /api/auth/activate (legacy shared-invite-code activation)
-- could only guess that an account was OAuth-created. oauthProviders records
-- the IdPs ('google' / 'github') that successfully signed the user in.
-- Additive, defaulted column: metadata-only on PostgreSQL 16, idempotent.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oauthProviders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Conservative backfill (provider unknown for legacy rows, so mark 'oauth'):
-- treat as OAuth-linked any user with an IdP avatar ("avatarUrl" IS NOT NULL;
-- only OAuth sign-in sets it) or a passwordless admin (bootstrap/OAuth admins
-- must never be claimable through the shared invite code). Erring toward
-- "marked" only makes activation stricter; those users keep their OAuth login.
UPDATE "users"
SET "oauthProviders" = ARRAY['oauth']::TEXT[]
WHERE cardinality("oauthProviders") = 0
  AND ("avatarUrl" IS NOT NULL OR ("passwordHash" IS NULL AND "role" = 'admin'));
