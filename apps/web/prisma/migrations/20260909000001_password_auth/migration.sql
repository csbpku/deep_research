-- Optional password credentials for deployments that do not use Google OAuth.
-- Existing users can set a password through the registration flow when this
-- column is still NULL; no existing password is ever overwritten.
ALTER TABLE "users"
  ADD COLUMN "passwordHash" VARCHAR(255);
