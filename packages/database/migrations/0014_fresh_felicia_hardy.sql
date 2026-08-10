CREATE TABLE "organization_admin_claims" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_admin_claims_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_admin_claims_kind_valid" CHECK ("organization_admin_claims"."kind" in ('creator', 'legacy_first_admin'))
);
--> statement-breakpoint
ALTER TABLE "organization_admin_claims" ADD CONSTRAINT "organization_admin_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_admin_claims" ADD CONSTRAINT "organization_admin_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_admin_claims_user_id_idx" ON "organization_admin_claims" USING btree ("user_id");