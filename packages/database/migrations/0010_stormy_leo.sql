ALTER TYPE "public"."agent_session_status" ADD VALUE 'stale';--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_status_fields_valid";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_status_fields_valid" CHECK ((
        ("agent_sessions"."status" = 'running' and "agent_sessions"."ended_at" is null)
        or
        ("agent_sessions"."status" in ('ended', 'stale') and "agent_sessions"."ended_at" is not null)
      ));