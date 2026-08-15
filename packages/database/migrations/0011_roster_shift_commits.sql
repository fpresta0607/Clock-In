ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE TABLE "shift_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"repo_root" text NOT NULL,
	"branch" text,
	"sha" text NOT NULL,
	"subject" text NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"verification" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_commits_organization_user_client_unique" UNIQUE("organization_id","user_id","client_id"),
	CONSTRAINT "shift_commits_organization_agent_repo_sha_unique" UNIQUE("organization_id","agent_id","repo_root","sha"),
	CONSTRAINT "shift_commits_verification_valid" CHECK ("shift_commits"."verification" in ('pending', 'merged', 'reverted', 'orphaned')),
	CONSTRAINT "shift_commits_sha_valid" CHECK ("shift_commits"."sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "shift_commits_repo_root_length_valid" CHECK (char_length("shift_commits"."repo_root") between 1 and 1000),
	CONSTRAINT "shift_commits_subject_length_valid" CHECK (char_length("shift_commits"."subject") <= 500),
	CONSTRAINT "shift_commits_branch_length_valid" CHECK ("shift_commits"."branch" is null or char_length("shift_commits"."branch") between 1 and 500),
	CONSTRAINT "shift_commits_verified_at_consistent" CHECK (("shift_commits"."verification" = 'pending') = ("shift_commits"."verified_at" is null))
);
--> statement-breakpoint
ALTER TABLE "shift_commits" ADD CONSTRAINT "shift_commits_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_commits" ADD CONSTRAINT "shift_commits_organization_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_commits" ADD CONSTRAINT "shift_commits_organization_session_fk" FOREIGN KEY ("organization_id","agent_session_id") REFERENCES "public"."agent_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_commits_organization_agent_authored_at_idx" ON "shift_commits" USING btree ("organization_id","agent_id","authored_at");