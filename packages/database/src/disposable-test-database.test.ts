import { afterEach, describe, expect, it, vi } from "vitest";

const { createDatabaseMock, postgresMock } = vi.hoisted(() => ({
  createDatabaseMock: vi.fn(),
  postgresMock: vi.fn(),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("./client.js", () => ({ createDatabase: createDatabaseMock }));

import { createDisposableTestDatabase, verifyDisposableTestDatabaseUrl } from "./disposable-test-database.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("createDisposableTestDatabase", () => {
  it("attempts exact disposable cleanup when CREATE DATABASE reports an error", async () => {
    const createError = new Error("connection dropped after create");
    const createControl = {
      unsafe: vi.fn().mockRejectedValue(createError),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const dropControl = {
      unsafe: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    postgresMock.mockReturnValueOnce(createControl).mockReturnValueOnce(dropControl);

    await expect(createDisposableTestDatabase("postgresql://user:secret@example.test:5432/source?siqshift_disposable_test_capability=local-test-capability", "create-failure", "local-test-capability"))
      .rejects.toThrow("Could not create the disposable integration database: connection dropped after create");

    expect(dropControl.unsafe).toHaveBeenCalledWith(expect.stringMatching(
      /^drop database if exists "siqshift_test_create_failu_[a-f0-9]+" with \(force\)$/,
    ));
    expect(dropControl.end).toHaveBeenCalledTimes(1);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  it("drops the created database when closing its creation connection fails", async () => {
    const closeError = new Error("control close failed");
    const createControl = {
      unsafe: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockRejectedValue(closeError),
    };
    const dropControl = {
      unsafe: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    postgresMock.mockReturnValueOnce(createControl).mockReturnValueOnce(dropControl);

    await expect(createDisposableTestDatabase("postgresql://user:secret@example.test:5432/source?siqshift_disposable_test_capability=local-test-capability", "close-failure", "local-test-capability"))
      .rejects.toBe(closeError);

    expect(createControl.unsafe).toHaveBeenCalledTimes(1);
    expect(dropControl.unsafe).toHaveBeenCalledTimes(1);
    expect(dropControl.end).toHaveBeenCalledTimes(1);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary database URL before opening a control connection", () => {
    expect(() => verifyDisposableTestDatabaseUrl("postgresql://user:secret@production.example/source", "local-test-capability"))
      .toThrow("explicit disposable-test capability");
    expect(postgresMock).not.toHaveBeenCalled();
  });
});
