CREATE TABLE "database_identity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"marker" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_identity_singleton" CHECK ("database_identity"."singleton")
);
