ALTER TABLE "organizations" ADD COLUMN "invite_code" text;--> statement-breakpoint
UPDATE "organizations" SET "invite_code" = replace(gen_random_uuid()::text, '-', '') WHERE "invite_code" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "invite_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_invite_code_unique" UNIQUE("invite_code");
