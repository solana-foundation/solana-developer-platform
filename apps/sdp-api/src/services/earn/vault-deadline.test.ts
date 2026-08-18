import { afterEach, describe, expect, it, vi } from "vitest";
import { createVaultDeadline, withVaultDeadline } from "./vault-deadline";

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

  it("shares one absolute budget across sequential operations", async () => {
    vi.useFakeTimers();
    const deadline = createVaultDeadline(25);
    const first = deadline.run(
      "first call",
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 15))
    );

    await vi.advanceTimersByTimeAsync(15);
    await expect(first).resolves.toBe("ok");

    const second = deadline.run("second call", () => new Promise<never>(() => undefined));
    const rejection = expect(second).rejects.toThrow("second call timed out after 25ms");

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it("does not start another operation after the absolute deadline", async () => {
    vi.useFakeTimers();
    const deadline = createVaultDeadline(25);
    const operation = vi.fn(async () => "too late");

    await vi.advanceTimersByTimeAsync(25);

    await expect(deadline.run("late call", operation)).rejects.toThrow(
      "late call timed out after 25ms"
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("exposes the same expiry check to nested provider boundaries", () => {
    vi.useFakeTimers();
    const deadline = createVaultDeadline(25);

    vi.advanceTimersByTime(25);

    expect(() => deadline.assertActive("nested provider read")).toThrow(
      "nested provider read timed out after 25ms"
    );
  });

  it("preserves an operation's own rejection", async () => {
    const deadline = createVaultDeadline(25);
    const cause = new Error("upstream failed");

    await expect(deadline.run("failing call", () => Promise.reject(cause))).rejects.toBe(cause);
  });

  it("consumes a rejection that arrives after the caller timed out", async () => {
    vi.useFakeTimers();
    let rejectOperation!: (cause: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const result = createVaultDeadline(25).run("late rejection", () => operation);
    const rejection = expect(result).rejects.toThrow("late rejection timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    // Vitest reports unhandled promise rejections as suite failures. This late
    // rejection is deliberately consumed by `VaultDeadline.run`.
    rejectOperation(new Error("settled too late"));
    await Promise.resolve();
  });
});
