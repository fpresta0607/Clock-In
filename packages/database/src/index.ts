export { createDatabase, type DatabaseConnection } from "./client.js";
export { createDisposableTestDatabase, type DisposableTestDatabase } from "./disposable-test-database.js";
export { backfillTrustedLegacySessionDevices, type LegacySessionDeviceScope } from "./legacy-session-devices.js";
export { runMigrations } from "./migrate.js";
export {
  activitySegmentKind,
  activitySegments,
  agentSessions,
  agentSessionStatus,
  agentSource,
  organizationAdminClaims,
  organizations,
  projectMemberships,
  projectPathMappings,
  projects,
  sessionStatus,
  timeSessions,
  userProjectSelections,
  users,
} from "./schema.js";
