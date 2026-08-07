import type { BootstrapSnapshot, RunningTimer, StartIntent, TimerProject, TimerUser } from "./timer-machine.js";

export type BridgeErrorKind = "auth" | "transient" | "conflict" | "validation" | "unknown";

export type BridgeError = {
  kind: BridgeErrorKind;
  message: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type SignupInput = LoginInput & {
  name: string;
};

export type StopInput = {
  sessionId: string;
  stoppedAt: string;
  idleSeconds: 0;
};

export type PendingRetryResult = {
  remaining: number;
};

export interface TimerBridge {
  bootstrap(): Promise<BootstrapSnapshot>;
  login(input: LoginInput): Promise<BootstrapSnapshot>;
  signup(input: SignupInput): Promise<BootstrapSnapshot>;
  logout(): Promise<void>;
  start(input: StartIntent): Promise<RunningTimer>;
  stop(input: StopInput): Promise<void>;
  retryPending(): Promise<PendingRetryResult>;
  useServerTimer(): Promise<BootstrapSnapshot>;
  retryLocalStart(input: StartIntent): Promise<BootstrapSnapshot>;
}

type TauriInvoke = <Result>(command: string, args?: Record<string, unknown>) => Promise<Result>;
type Decoder<Value> = (value: unknown) => Value;

const invalidResponse = (): never => {
  throw { kind: "unknown", message: "The desktop service returned an invalid response." } satisfies BridgeError;
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
};

const string = (value: unknown): string => {
  if (typeof value !== "string") invalidResponse();
  return value as string;
};

const uuid = (value: unknown): string => {
  const result = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) invalidResponse();
  return result;
};

const timestamp = (value: unknown): string => {
  const result = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || Number.isNaN(Date.parse(result))) invalidResponse();
  return result;
};

const nonnegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value as number;
};

export const decodeStartIntent = (value: unknown): StartIntent => {
  const candidate = record(value);
  return {
    clientId: uuid(candidate.clientId),
    projectId: uuid(candidate.projectId),
    description: string(candidate.description),
    startedAt: timestamp(candidate.startedAt),
  };
};

export const decodeRunningTimer = (value: unknown): RunningTimer => {
  const candidate = record(value);
  return { ...decodeStartIntent(candidate), sessionId: uuid(candidate.sessionId) };
};

const decodeUser = (value: unknown): TimerUser => {
  const candidate = record(value);
  return { id: uuid(candidate.id), email: string(candidate.email), name: string(candidate.name) };
};

const decodeProject = (value: unknown): TimerProject => {
  const candidate = record(value);
  if (candidate.color !== null && typeof candidate.color !== "string") invalidResponse();
  return { id: uuid(candidate.id), name: string(candidate.name), color: candidate.color as string | null };
};

type DecodedAccount = { user: TimerUser; projects: readonly TimerProject[] };

const decodeAccount = (candidate: Record<string, unknown>): DecodedAccount => {
  const projects = candidate.projects;
  if (!Array.isArray(projects)) invalidResponse();
  return { user: decodeUser(candidate.user), projects: (projects as unknown[]).map(decodeProject) };
};

export const decodeBootstrapSnapshot = (value: unknown): BootstrapSnapshot => {
  const candidate = record(value);
  switch (candidate.kind) {
    case "signed-out":
      return { kind: "signed-out" };
    case "idle":
      return { kind: "idle", ...decodeAccount(candidate) };
    case "running": {
      const source = candidate.source;
      if (source !== "local-server-match" && source !== "server-only") invalidResponse();
      return { kind: "running", ...decodeAccount(candidate), running: decodeRunningTimer(candidate.running), source: source as "local-server-match" | "server-only" };
    }
    case "retry-local-start":
      return { kind: "retry-local-start", ...decodeAccount(candidate), start: decodeStartIntent(candidate.start) };
    case "pending-sync":
      return { kind: "pending-sync", ...decodeAccount(candidate), pendingCount: nonnegativeInteger(candidate.pendingCount) };
    case "conflict":
      return {
        kind: "conflict",
        ...decodeAccount(candidate),
        localStart: decodeStartIntent(candidate.localStart),
        serverRunning: decodeRunningTimer(candidate.serverRunning),
      };
    default:
      return invalidResponse();
  }
};

export const decodePendingRetryResult = (value: unknown): PendingRetryResult => {
  const candidate = record(value);
  return { remaining: nonnegativeInteger(candidate.remaining) };
};

const decodeVoid = (value: unknown): void => {
  if (value !== undefined && value !== null) invalidResponse();
};

const tauriInvoke = async <Result>(command: string, args?: Record<string, unknown>): Promise<Result> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Result>(command, args);
};

const invoke = <Result>(command: string, args?: Record<string, unknown>): Promise<Result> =>
  (tauriInvoke as TauriInvoke)(command, args);

const invokeDecoded = <Result>(command: string, decoder: Decoder<Result>, args?: Record<string, unknown>): Promise<Result> =>
  invoke<unknown>(command, args).then(decoder);

export const defaultBridge: TimerBridge = {
  bootstrap: () => invokeDecoded("timer_bootstrap", decodeBootstrapSnapshot),
  login: (input) => invokeDecoded("auth_login", decodeBootstrapSnapshot, { input }),
  signup: (input) => invokeDecoded("auth_signup", decodeBootstrapSnapshot, { input }),
  logout: () => invokeDecoded("auth_logout", decodeVoid),
  start: (input) => invokeDecoded("timer_start", decodeRunningTimer, { input }),
  stop: (input) => invokeDecoded("timer_stop", decodeVoid, { input }),
  retryPending: () => invokeDecoded("timer_retry_pending", decodePendingRetryResult),
  useServerTimer: () => invokeDecoded("timer_use_server", decodeBootstrapSnapshot),
  retryLocalStart: (input) => invokeDecoded("timer_retry_local_start", decodeBootstrapSnapshot, { input }),
};

export const bridgeError = (error: unknown): BridgeError => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown; code?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "The desktop service did not complete the request.";
    if (
      candidate.kind === "auth"
      || candidate.kind === "transient"
      || candidate.kind === "conflict"
      || candidate.kind === "validation"
      || candidate.kind === "unknown"
    ) {
      return { kind: candidate.kind, message };
    }
    if (candidate.code === "unauthorized" || candidate.code === "invalid_credentials") return { kind: "auth", message };
  }
  return { kind: "unknown", message: "The desktop service did not complete the request." };
};
