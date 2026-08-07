CREATE TYPE "public"."activity_segment_kind" AS ENUM('active', 'idle', 'locked', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."agent_session_status" AS ENUM('running', 'ended');--> statement-breakpoint
CREATE TYPE "public"."agent_source" AS ENUM('claude_code', 'codex', 'kimi_code', 'other');--> statement-breakpoint
CREATE TABLE "activity_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" "activity_segment_kind" NOT NULL,
	"process_name" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_segments_organization_user_client_unique" UNIQUE("organization_id","user_id","client_id"),
	CONSTRAINT "activity_segments_time_order_valid" CHECK ("activity_segments"."ended_at" > "activity_segments"."started_at"),
	CONSTRAINT "activity_segments_process_name_length_valid" CHECK ("activity_segments"."process_name" is null or char_length("activity_segments"."process_name") <= 200)
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "agent_source" NOT NULL,
	"external_session_id" text NOT NULL,
	"project_id" uuid,
	"cwd" text NOT NULL,
	"status" "agent_session_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_event_at" timestamp with time zone NOT NULL,
	"linked_session_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_organization_user_source_external_unique" UNIQUE("organization_id","user_id","source","external_session_id"),
	CONSTRAINT "agent_sessions_status_fields_valid" CHECK ((
        ("agent_sessions"."status" = 'running' and "agent_sessions"."ended_at" is null)
        or
        ("agent_sessions"."status" = 'ended' and "agent_sessions"."ended_at" is not null)
      )),
	CONSTRAINT "agent_sessions_external_session_id_length_valid" CHECK (char_length("agent_sessions"."external_session_id") between 1 and 200),
	CONSTRAINT "agent_sessions_cwd_length_valid" CHECK (char_length("agent_sessions"."cwd") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "project_path_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"path_prefix" text NOT NULL,
	"repo_url" text,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_path_mappings_organization_user_prefix_unique" UNIQUE("organization_id","user_id","path_prefix"),
	CONSTRAINT "project_path_mappings_path_prefix_length_valid" CHECK (char_length("project_path_mappings"."path_prefix") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "activity_segments" ADD CONSTRAINT "activity_segments_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_linked_session_id_time_sessions_id_fk" FOREIGN KEY ("linked_session_id") REFERENCES "public"."time_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_path_mappings" ADD CONSTRAINT "project_path_mappings_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_path_mappings" ADD CONSTRAINT "project_path_mappings_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_segments_organization_user_started_at_idx" ON "activity_segments" USING btree ("organization_id","user_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_organization_user_started_at_idx" ON "agent_sessions" USING btree ("organization_id","user_id","started_at");