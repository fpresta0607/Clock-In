import { createDatabase } from "@clock-in/database";

import { createApp } from "./app.js";
import { createNeonAuthKeys } from "./auth.js";
import {
  DrizzleAccountStore,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";
import { parseEnv } from "./env.js";
import { serveApp } from "./index.js";

const config = parseEnv(process.env);
const { db } = createDatabase(config.databaseUrl);

serveApp(
  createApp({
    config,
    keys: createNeonAuthKeys(config),
    accounts: new DrizzleAccountStore(db),
    projectRepository: new DrizzleProjectRepository(db),
    sessionRepository: new DrizzleSessionRepository(db),
    reportRepository: new DrizzleReportRepository(db),
  }),
  config,
);

console.info(`Clock-In API listening on port ${config.port}.`);
