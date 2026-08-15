CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'anonymous' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agents_organization_source_project_unique" UNIQUE NULLS NOT DISTINCT("organization_id","source","project_id"),
	CONSTRAINT "agents_status_valid" CHECK ("agents"."status" in ('anonymous', 'registered', 'retired')),
	CONSTRAINT "agents_source_valid" CHECK ("agents"."source" ~ '^[a-z][a-z0-9_]*$' and char_length("agents"."source") <= 40),
	CONSTRAINT "agents_name_length_valid" CHECK (char_length("agents"."name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_owner_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_organization_id_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;