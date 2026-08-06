CREATE TABLE "confluence_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "accessTokenEnc" TEXT NOT NULL,
  "refreshTokenEnc" TEXT NOT NULL,
  "cloudId" VARCHAR(255),
  "expiresAt" TIMESTAMPTZ(3),
  "oauthStateHash" CHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "confluence_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "confluence_connections_userId_key" UNIQUE ("userId"),
  CONSTRAINT "confluence_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
