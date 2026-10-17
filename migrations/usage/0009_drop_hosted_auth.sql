-- Better Auth's people and sessions left this database for the auth Worker's own `SignIn` database (ADR 0030, #130,
-- migrations/sign-in/): nothing reads or writes the `auth_` tables 0008_hosted_auth.sql created any more, and the first
-- sign-in on the auth host starts fresh. Drops them, so this database holds usage records only. Contraction only: the
-- tables of the usage records are not touched, and `IF EXISTS` makes a second run a no-op. The indexes go first by name
-- (a dropped table takes its indexes along, this just says which ones they are); the tables that reference `auth_user`
-- go before it, as its foreign keys require.
DROP INDEX IF EXISTS "auth_verification_identifier_idx";
DROP INDEX IF EXISTS "auth_account_userId_idx";
DROP INDEX IF EXISTS "auth_session_userId_idx";
DROP TABLE IF EXISTS "auth_verification";
DROP TABLE IF EXISTS "auth_account";
DROP TABLE IF EXISTS "auth_session";
DROP TABLE IF EXISTS "auth_user";
