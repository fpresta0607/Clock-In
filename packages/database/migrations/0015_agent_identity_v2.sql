DROP INDEX "agents_organization_source_project_unique";--> statement-breakpoint
DROP INDEX "agents_organization_source_unassigned_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "repo_root" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_owner_source_repo_unique" ON "agents" USING btree ("organization_id","owner_user_id","source","repo_root") WHERE "agents"."repo_root" is not null and "agents"."status" <> 'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "agents_organization_owner_source_unassigned_unique" ON "agents" USING btree ("organization_id","owner_user_id","source") WHERE "agents"."repo_root" is null and "agents"."status" <> 'retired';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_repo_root_length_valid" CHECK ("agents"."repo_root" is null or char_length("agents"."repo_root") between 1 and 1000);