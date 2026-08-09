ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_cwd_length_valid";--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "cwd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_cwd_length_valid" CHECK ("agent_sessions"."cwd" is null or char_length("agent_sessions"."cwd") between 1 and 1000);