import { createDatabase } from "@clock-in/database";

import { createApp } from "./app.js";
import { createNeonAuthKeys } from "./auth.js";
import {
  DrizzleAccountStore,
  DrizzleActivitySegmentRepository,
  DrizzleAgentRepository,
  DrizzleAgentSessionRepository,
  DrizzlePathMappingRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
  DrizzleShiftCommitRepository,
  DrizzleViewPreferencesRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { serveApp } from "./index.js";

const config = parseEnv(process.env);
const { client, db } = createDatabase(config.databaseUrl);

const server = serveApp(
  createApp({
    config,
    keys: createNeonAuthKeys(config),
    accounts: new DrizzleAccountStore(db),
    projectRepository: new DrizzleProjectRepository(db),
    sessionRepository: new DrizzleSessionRepository(db),
    reportRepository: new DrizzleReportRepository(db),
    activitySegmentRepository: new DrizzleActivitySegmentRepository(db),
    agentSessionRepository: new DrizzleAgentSessionRepository(db),
    agentRepository: new DrizzleAgentRepository(db),
    shiftCommitRepository: new DrizzleShiftCommitRepository(db),
    pathMappingRepository: new DrizzlePathMappingRepository(db),
    viewPreferencesRepository: new DrizzleViewPreferencesRepository(db),
  }),
  config,
);

console.info(`Clock-In API listening on port ${config.port}.`);

// Platforms send SIGTERM and then kill after a grace period. Finish in-flight
// requests and close the pool so a deploy never severs a timer mid-write.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; draining.`);
    server.close(() => {
      void client.end({ timeout: 5 }).finally(() => process.exit(0));
    });
    // A connection held open past the platform's grace period must not stop the
    // process from exiting cleanly.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
