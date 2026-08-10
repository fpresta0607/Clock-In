CREATE TABLE "user_project_selections" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_project_selections_organization_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_project_selections" ADD CONSTRAINT "user_project_selections_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_selections" ADD CONSTRAINT "user_project_selections_membership_fk" FOREIGN KEY ("organization_id","user_id","project_id") REFERENCES "public"."project_memberships"("organization_id","user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_project_selections_project_id_idx" ON "user_project_selections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_one_default_per_organization" ON "projects" USING btree ("organization_id") WHERE "projects"."is_default";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_active" CHECK (not ("projects"."is_default" and "projects"."archived"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('admin', 'member'));