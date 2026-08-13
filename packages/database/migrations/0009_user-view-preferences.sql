CREATE TABLE "user_view_preferences" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"range" text DEFAULT '30d' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_view_preferences_organization_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "user_view_preferences_scope_valid" CHECK (char_length("user_view_preferences"."scope") between 1 and 40),
	CONSTRAINT "user_view_preferences_range_valid" CHECK ("user_view_preferences"."range" in ('today', '7d', '30d', '90d', 'all'))
);
--> statement-breakpoint
ALTER TABLE "user_view_preferences" ADD CONSTRAINT "user_view_preferences_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;