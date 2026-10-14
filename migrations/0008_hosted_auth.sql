-- Better Auth's people and sessions on a hosted proxy (ADR 0026, src/hosted/auth.ts): the tables its core needs, prefixed
-- `auth_` because they share this database with the usage records. A self-hosted proxy creates them too and leaves them
-- empty. New tables only: nothing that exists is changed, and `IF NOT EXISTS` makes a second run a no-op. The provider
-- tokens, address and user agent columns stay empty (the Worker never stores them); Better Auth expects them.
CREATE TABLE IF NOT EXISTS "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE IF NOT EXISTS "auth_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);
CREATE TABLE IF NOT EXISTS "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE IF NOT EXISTS "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE INDEX IF NOT EXISTS "auth_session_userId_idx" ON "auth_session" ("userId");
CREATE INDEX IF NOT EXISTS "auth_account_userId_idx" ON "auth_account" ("userId");
CREATE INDEX IF NOT EXISTS "auth_verification_identifier_idx" ON "auth_verification" ("identifier");
