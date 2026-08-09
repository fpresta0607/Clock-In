ALTER TYPE "public"."agent_source" ADD VALUE 'browser' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "project_path_mappings" ADD COLUMN "kind" text DEFAULT 'path_prefix' NOT NULL;