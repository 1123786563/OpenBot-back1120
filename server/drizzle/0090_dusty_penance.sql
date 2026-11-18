CREATE TABLE "personal_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_organizations_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_source" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_organizations" ADD CONSTRAINT "personal_organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_personal_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."personal_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_organization_id_personal_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."personal_organizations"("id") ON DELETE no action ON UPDATE no action;