import { afterEach, describe, expect, it, vi } from "vitest";
import { withVaultDeadline } from "./vault-deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("withVaultDeadline", () => {
  it("returns an external result before the deadline", async () => {
    await expect(withVaultDeadline(Promise.resolve("ok"), "test call", 25)).resolves.toBe("ok");
  });

  it("rejects a call that never settles within its bound", async () => {
    vi.useFakeTimers();
    const result = withVaultDeadline(new Promise<never>(() => undefined), "test call", 25);
    const rejection = expect(result).rejects.toThrow("test call timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });
});
