import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@/db";
import { scheduleApiKeyLastUsedUpdate } from "./auth";

function createDatabase(run: ReturnType<typeof vi.fn>) {
  const boundStatement = { run };
  const preparedStatement = {
    bind: vi.fn(() => boundStatement),
  };
  const db = {
    prepare: vi.fn(() => preparedStatement),
  } as unknown as DatabaseClient;

  return { db, preparedStatement };
}

describe("API key last-used write scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces successful Node writes for five minutes per key", async () => {
    const run = vi.fn(async () => 1);
    const { db, preparedStatement } = createDatabase(run);
    const startedAt = 1_000_000;

    const first = scheduleApiKeyLastUsedUpdate(db, "key-node-success", "node", startedAt);
    const concurrent = scheduleApiKeyLastUsedUpdate(db, "key-node-success", "node", startedAt + 1);
    expect(concurrent).toBe(first);
    await Promise.all([first, concurrent]);

    await scheduleApiKeyLastUsedUpdate(db, "key-node-success", "node", startedAt + 5 * 60_000 - 1);
    expect(run).toHaveBeenCalledOnce();
    expect(preparedStatement.bind).toHaveBeenCalledWith("key-node-success");

    await scheduleApiKeyLastUsedUpdate(db, "key-node-success", "node", startedAt + 5 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce the same key id across different databases", async () => {
    const firstRun = vi.fn(async () => 1);
    const secondRun = vi.fn(async () => 1);
    const firstDb = createDatabase(firstRun).db;
    const secondDb = createDatabase(secondRun).db;

    await Promise.all([
      scheduleApiKeyLastUsedUpdate(firstDb, "shared-key", "node", 2_000_000),
      scheduleApiKeyLastUsedUpdate(secondDb, "shared-key", "node", 2_000_000),
    ]);

    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
  });

  it("allows the next Node request to retry after a failed write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValue(1);
    const { db } = createDatabase(run);

    await scheduleApiKeyLastUsedUpdate(db, "key-node-retry", "node", 3_000_000);
    await scheduleApiKeyLastUsedUpdate(db, "key-node-retry", "node", 3_000_001);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves a write for every Cloudflare request", async () => {
    const run = vi.fn(async () => 1);
    const { db } = createDatabase(run);

    await scheduleApiKeyLastUsedUpdate(db, "key-cloudflare", "cloudflare", 4_000_000);
    await scheduleApiKeyLastUsedUpdate(db, "key-cloudflare", "cloudflare", 4_000_001);

    expect(run).toHaveBeenCalledTimes(2);
  });
});
