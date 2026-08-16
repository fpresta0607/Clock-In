CREATE TABLE "agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"bucket_start_at" timestamp with time zone NOT NULL,
	"model" text,
	"sidechain" boolean NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_creation_input_tokens" bigint NOT NULL,
	"cache_read_input_tokens" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_organization_user_client_unique" UNIQUE("organization_id","user_id","client_id"),
	CONSTRAINT "agent_usage_organization_session_bucket_unique" UNIQUE NULLS NOT DISTINCT("organization_id","agent_session_id","bucket_start_at","model","sidechain"),
	CONSTRAINT "agent_usage_input_tokens_nonnegative" CHECK ("agent_usage"."input_tokens" >= 0),
	CONSTRAINT "agent_usage_output_tokens_nonnegative" CHECK ("agent_usage"."output_tokens" >= 0),
	CONSTRAINT "agent_usage_cache_creation_input_tokens_nonnegative" CHECK ("agent_usage"."cache_creation_input_tokens" >= 0),
	CONSTRAINT "agent_usage_cache_read_input_tokens_nonnegative" CHECK ("agent_usage"."cache_read_input_tokens" >= 0),
	CONSTRAINT "agent_usage_model_length_valid" CHECK ("agent_usage"."model" is null or char_length("agent_usage"."model") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_organization_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_organization_session_fk" FOREIGN KEY ("organization_id","agent_session_id") REFERENCES "public"."agent_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_usage_organization_agent_bucket_idx" ON "agent_usage" USING btree ("organization_id","agent_id","bucket_start_at");