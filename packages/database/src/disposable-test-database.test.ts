import { afterEach, describe, expect, it, vi } from "vitest";

const { createDatabaseMock, postgresMock } = vi.hoisted(() => ({
  createDatabaseMock: vi.fn(),
  postgresMock: vi.fn(),
}));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("./client.js", () => ({ createDatabase: createDatabaseMock }));

import { createDisposableTestDatabase } from "./disposable-test-database.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("createDisposableTestDatabase", () => {
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

    await expect(createDisposableTestDatabase("postgresql://user:secret@example.test:5432/source", "close-failure"))
      .rejects.toBe(closeError);

    expect(createControl.unsafe).toHaveBeenCalledTimes(1);
    expect(dropControl.unsafe).toHaveBeenCalledTimes(1);
    expect(dropControl.end).toHaveBeenCalledTimes(1);
    expect(createDatabaseMock).not.toHaveBeenCalled();
  });
});
