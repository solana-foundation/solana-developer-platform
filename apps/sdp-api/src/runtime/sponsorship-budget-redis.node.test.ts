import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SponsorshipBudgetPolicy } from "@/db/repositories/sponsorship-budget.repository";
import type { Env } from "@/types/env";
import { closeAllRedisClients } from "./kv-redis";
import { SponsorshipBudgetRedis } from "./sponsorship-budget-redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const EMPTY_USAGE = {
  hour: { global: 0, organization: 0, project: 0 },
  day: { global: 0, organization: 0, project: 0 },
};

function policy(
  scopeType: SponsorshipBudgetPolicy["scopeType"],
  version = 1,
  enabled = true,
  limit = 10
): SponsorshipBudgetPolicy {
  return {
    id: `policy_${scopeType}`,
    network: "devnet",
    scopeType,
    scopeId: null,
    enabled,
    perTransactionLamports: limit,
    hourlyLamports: limit,
    dailyLamports: limit,
    version,
    updatedBy: "test",
    updateReason: "test",
    updatedAt: new Date(0).toISOString(),
  };
}

describe("SponsorshipBudgetRedis", () => {
  let raw: Redis;
  let budget: SponsorshipBudgetRedis;

  beforeAll(() => {
    raw = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
    budget = new SponsorshipBudgetRedis({ REDIS_URL } as Env);
  });

  afterAll(async () => {
    await closeAllRedisClients();
    await raw.quit();
  });

  beforeEach(async () => {
    await raw.flushall();
  });

  it("admits organization-only scopes without corrupting Lua argument indexes", async () => {
    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "reservation_org",
        amount: 3,
        policies: [policy("global"), policy("organization")],
        usage: EMPTY_USAGE,
      })
    ).resolves.toBe("admitted");

    const hour = await raw.hgetall("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z");
    expect(hour).toMatchObject({ global: "3", "organization:org_1": "3" });
    expect(Object.keys(hour).some((field) => field.includes("undefined"))).toBe(false);
  });

  it("enforces concurrent limits atomically across all applicable scopes", async () => {
    const policies = [policy("global", 1, true, 5), policy("organization", 1, true, 3)];
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        budget.reserve({
          network: "devnet",
          organizationId: "org_1",
          projectId: null,
          hourBucket: "2026-08-03T10:00:00.000Z",
          dayBucket: "2026-08-03T00:00:00.000Z",
          reservationId: `reservation_${index}`,
          amount: 1,
          policies,
          usage: EMPTY_USAGE,
        })
      )
    );
    expect(attempts.filter((result) => result === "admitted")).toHaveLength(3);
    const hour = await raw.hgetall("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z");
    expect(hour.global).toBe("3");
    expect(hour["organization:org_1"]).toBe("3");
  });

  it("rejects a stale policy version without incrementing counters", async () => {
    await budget.syncPolicy(policy("global", 2));
    const result = await budget.reserve({
      network: "devnet",
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_stale",
      amount: 1,
      policies: [policy("global", 1), policy("organization", 1)],
      usage: EMPTY_USAGE,
    });
    expect(result).toBe("stale_policy");
    expect(
      await raw.hget(
        "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z",
        "global"
      )
    ).toBe("0");
  });

  it("does not let a Redis-only duplicate bypass a later kill", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_orphan",
      amount: 1,
      policies: [policy("global", 1), policy("organization", 1)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    const killed = policy("global", 2, false);
    await budget.syncPolicy(killed);
    await expect(
      budget.reserve({ ...input, policies: [killed, policy("organization", 1)] })
    ).resolves.toBe("stale_policy");
  });
});
