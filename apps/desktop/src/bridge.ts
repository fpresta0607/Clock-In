import type { BootstrapSnapshot, RunningTimer, StartIntent } from "./timer-machine.js";

export type BridgeErrorKind = "auth" | "transient" | "conflict" | "validation" | "unknown";

export type BridgeError = {
  kind: BridgeErrorKind;
  message: string;
};

export type LoginInput = {
  email: string;
  password: string;
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
  logout(): Promise<void>;
  start(input: StartIntent): Promise<RunningTimer>;
  stop(input: StopInput): Promise<void>;
  retryPending(): Promise<PendingRetryResult>;
  useServerTimer(): Promise<BootstrapSnapshot>;
  retryLocalStart(input: StartIntent): Promise<BootstrapSnapshot>;
}

type TauriInvoke = <Result>(command: string, args?: Record<string, unknown>) => Promise<Result>;

const tauriInvoke = async <Result>(command: string, args?: Record<string, unknown>): Promise<Result> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Result>(command, args);
};

const invoke = <Result>(command: string, args?: Record<string, unknown>): Promise<Result> =>
  (tauriInvoke as TauriInvoke)(command, args);

export const defaultBridge: TimerBridge = {
  bootstrap: () => invoke<BootstrapSnapshot>("timer_bootstrap"),
  login: (input) => invoke<BootstrapSnapshot>("auth_login", { input }),
  logout: () => invoke<void>("auth_logout"),
  start: (input) => invoke<RunningTimer>("timer_start", { input }),
  stop: (input) => invoke<void>("timer_stop", { input }),
  retryPending: () => invoke<PendingRetryResult>("timer_retry_pending"),
  useServerTimer: () => invoke<BootstrapSnapshot>("timer_use_server"),
  retryLocalStart: (input) => invoke<BootstrapSnapshot>("timer_retry_local_start", { input }),
};

export const bridgeError = (error: unknown): BridgeError => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { kind?: unknown; message?: unknown; code?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : "The desktop service did not complete the request.";
    if (
      candidate.kind === "auth" ||
      candidate.kind === "transient" ||
      candidate.kind === "conflict" ||
      candidate.kind === "validation" ||
      candidate.kind === "unknown"
    ) {
      return { kind: candidate.kind, message };
    }
    if (candidate.code === "unauthorized" || candidate.code === "invalid_credentials") return { kind: "auth", message };
  }
  return { kind: "unknown", message: "The desktop service did not complete the request." };
};
