import { createDatabase, type DatabaseConnection } from "./client.js";
import { organizations, projectMemberships, projects, users } from "./schema.js";

const developmentOrganizationId = "00000000-0000-4000-8000-000000000001";
const developmentUserId = "00000000-0000-4000-8000-000000000002";
const developmentProjectId = "00000000-0000-4000-8000-000000000003";
const developmentEmail = "dev@clock-in.test";
const developmentPassword = "clock-in-development-only";
const developmentPasswordHash = "$argon2id$v=19$m=65536,t=3,p=4$OkdlLdh793IA7hen/DfHcg$dGpuA/K8HfNbNTRXAUfXZSMn5Q3lc0yhgaJgIP9aOOQ";

export async function seedDevelopmentDatabase(database: DatabaseConnection): Promise<void> {
  await database.db
    .insert(organizations)
    .values({ id: developmentOrganizationId, name: "Clock-In Development" })
    .onConflictDoNothing();
  await database.db
    .insert(users)
    .values({
      id: developmentUserId,
      organizationId: developmentOrganizationId,
      email: developmentEmail,
      name: "Development User",
      passwordHash: developmentPasswordHash,
    })
    .onConflictDoNothing();
  await database.db
    .insert(projects)
    .values({ id: developmentProjectId, organizationId: developmentOrganizationId, name: "Development Project" })
    .onConflictDoNothing();
  await database.db
    .insert(projectMemberships)
    .values({
      organizationId: developmentOrganizationId,
      projectId: developmentProjectId,
      userId: developmentUserId,
    })
    .onConflictDoNothing();
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Development seeding is disabled in production.");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed development data.");
  }

  const database = createDatabase(databaseUrl);
  try {
    await seedDevelopmentDatabase(database);
    console.info(`Development seed applied. Login: ${developmentEmail}; password: ${developmentPassword}`);
  } finally {
    await database.client.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Development seed failed.");
    process.exitCode = 1;
  });
}
