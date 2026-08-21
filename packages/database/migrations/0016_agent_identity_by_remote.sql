DROP INDEX "agents_organization_owner_source_repo_unique";--> statement-breakpoint
DROP INDEX "agents_organization_owner_source_unassigned_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "repo_key" text;--> statement-breakpoint
-- Backfill, hand-added to the generated statements and deliberately placed
-- between the column and the indexes that key on it. Every existing row was
-- keyed on its repo root, so it carries forward into the path lane verbatim -
-- `identityRepoKey` composes the same string for a repository with no remote,
-- so a shift replaying after this migration finds its own row rather than
-- minting a second one. Verbatim is also what makes the index below safe:
-- repo_root was already unique per (organization, owner, source) among live
-- rows, so prefixing it cannot fold two rows onto one key. Nothing here reads
-- a remote; scripts/repair-agent-identity-by-remote.mjs upgrades these keys to
-- remotes later, from a machine that has the checkouts.
UPDATE "agents" SET "repo_key" = 'path:' || "repo_root" WHERE "repo_root" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_owner_source_repo_key_unique" ON "agents" USING btree ("organization_id","owner_user_id","source","repo_key") WHERE "agents"."repo_key" is not null and "agents"."status" <> 'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_owner_source_unassigned_unique" ON "agents" USING btree ("organization_id","owner_user_id","source") WHERE "agents"."repo_key" is null and "agents"."status" <> 'retired';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_repo_key_length_valid" CHECK ("agents"."repo_key" is null or char_length("agents"."repo_key") between 1 and 1005);
