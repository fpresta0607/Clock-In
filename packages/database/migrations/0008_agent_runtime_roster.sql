CREATE TABLE "organization_admin_claims" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_admin_claims_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_admin_claims_kind_valid" CHECK ("organization_admin_claims"."kind" in ('creator', 'legacy_first_admin'))
);
--> statement-breakpoint
CREATE TABLE "user_project_selections" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_project_selections_organization_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_cwd_length_valid";--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "cwd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_admin_claims" ADD CONSTRAINT "organization_admin_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_admin_claims" ADD CONSTRAINT "organization_admin_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_selections" ADD CONSTRAINT "user_project_selections_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_selections" ADD CONSTRAINT "user_project_selections_membership_fk" FOREIGN KEY ("organization_id","user_id","project_id") REFERENCES "public"."project_memberships"("organization_id","user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_admin_claims_user_id_idx" ON "organization_admin_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_project_selections_project_id_idx" ON "user_project_selections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_one_default_per_organization" ON "projects" USING btree ("organization_id") WHERE "projects"."is_default";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_source_valid" CHECK ("agent_sessions"."source" ~ '^[a-z][a-z0-9_]*$' and char_length("agent_sessions"."source") <= 40);--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_model_length_valid" CHECK ("agent_sessions"."model" is null or char_length("agent_sessions"."model") between 1 and 200);--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_cwd_length_valid" CHECK ("agent_sessions"."cwd" is null or char_length("agent_sessions"."cwd") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_active" CHECK (not ("projects"."is_default" and "projects"."archived"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('admin', 'member'));--> statement-breakpoint
DROP TYPE "public"."agent_source";