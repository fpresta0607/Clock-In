CREATE TYPE "session_status" AS ENUM('running', 'stopped', 'needs_review');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_organization_user_project_unique" UNIQUE("organization_id","user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "time_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"idle_seconds" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_sessions_organization_user_client_unique" UNIQUE("organization_id","user_id","client_id"),
	CONSTRAINT "time_sessions_idle_seconds_nonnegative" CHECK ("time_sessions"."idle_seconds" >= 0),
	CONSTRAINT "time_sessions_duration_seconds_nonnegative" CHECK ("time_sessions"."duration_seconds" is null or "time_sessions"."duration_seconds" >= 0),
	CONSTRAINT "time_sessions_status_fields_valid" CHECK ((
        ("time_sessions"."status" = 'running' and "time_sessions"."stopped_at" is null and "time_sessions"."duration_seconds" is null)
        or
        ("time_sessions"."status" in ('stopped', 'needs_review') and "time_sessions"."stopped_at" is not null and "time_sessions"."duration_seconds" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "users_organization_id_email_unique" UNIQUE("organization_id","email")
);
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_sessions" ADD CONSTRAINT "time_sessions_membership_fk" FOREIGN KEY ("organization_id","user_id","project_id") REFERENCES "project_memberships"("organization_id","user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_memberships_user_id_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_project_id_idx" ON "project_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_organization_id_archived_idx" ON "projects" USING btree ("organization_id","archived");--> statement-breakpoint
CREATE UNIQUE INDEX "time_sessions_one_running_user_unique" ON "time_sessions" USING btree ("user_id") WHERE "time_sessions"."status" = 'running';--> statement-breakpoint
CREATE INDEX "time_sessions_organization_project_started_at_idx" ON "time_sessions" USING btree ("organization_id","project_id","started_at");--> statement-breakpoint
CREATE INDEX "time_sessions_organization_user_started_at_idx" ON "time_sessions" USING btree ("organization_id","user_id","started_at");--> statement-breakpoint
CREATE INDEX "users_organization_id_idx" ON "users" USING btree ("organization_id");
