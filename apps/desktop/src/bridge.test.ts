import { defaultBridge } from "./bridge.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { describe, expect, it, vi } from "vitest";

describe("defaultBridge", () => {
  it("rejects malformed bootstrap kinds and projects as unknown bridge errors", async () => {
    invoke.mockResolvedValueOnce({ kind: "unexpected" });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      kind: "idle",
      user: { id: "00000000-0000-4000-8000-000000000001", email: "timer@example.com", name: "Timer" },
      projects: [{ id: "00000000-0000-4000-8000-000000000010", name: "Field work", color: 42 }],
    });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("rejects malformed timer timestamps and pending retry counts", async () => {
    invoke.mockResolvedValueOnce({
      kind: "running",
      user: { id: "00000000-0000-4000-8000-000000000001", email: "timer@example.com", name: "Timer" },
      projects: [],
      running: {
        clientId: "00000000-0000-4000-8000-000000000100",
        projectId: "00000000-0000-4000-8000-000000000010",
        sessionId: "00000000-0000-4000-8000-000000000200",
        description: "Inspect relay",
        startedAt: "not-a-timestamp",
      },
      source: "server-only",
    });
    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ remaining: -1 });
    await expect(defaultBridge.retryPending()).rejects.toMatchObject({ kind: "unknown" });
  });
});
