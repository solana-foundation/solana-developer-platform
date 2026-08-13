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
        attempt: 1,
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
          attempt: 1,
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

  it("restores each newly-seen organization field from durable usage", async () => {
    const policies = [policy("global", 1, true, 100), policy("organization", 1, true, 10)];
    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "reservation_org_1",
        attempt: 1,
        amount: 3,
        policies,
        usage: EMPTY_USAGE,
      })
    ).resolves.toBe("admitted");
    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_2",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "reservation_org_2",
        attempt: 1,
        amount: 4,
        policies,
        usage: {
          hour: { global: 10, organization: 7, project: 0 },
          day: { global: 10, organization: 7, project: 0 },
        },
      })
    ).resolves.toBe("denied");
    expect(
      await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "organization:org_2")
    ).toBe("7");
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
      attempt: 1,
      amount: 1,
      policies: [policy("global", 1), policy("organization", 1)],
      usage: EMPTY_USAGE,
    });
    expect(result).toBe("stale_policy");
    expect(await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "global")).toBe(
      "0"
    );
  });

  it("does not let a Redis-only duplicate bypass a later kill", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_orphan",
      attempt: 1,
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

  it.each([
    { actualLamports: 2, label: "refund" },
    { actualLamports: 3, label: "two-lamport refund" },
    { actualLamports: 4, label: "one-lamport refund" },
    { actualLamports: 7, label: "over-reservation" },
  ])("settles $label exactly once across retries", async ({ actualLamports }) => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: `reservation_settle_${actualLamports}`,
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    const settlement = {
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: 1,
      reservedLamports: input.amount,
      actualLamports,
    };
    await budget.settle(settlement);
    await budget.settle(settlement);
    expect(await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "global")).toBe(
      String(actualLamports)
    );
  });

  it("rejects cancel and settlement from an attempt that does not own the reservation", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_owned",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");

    await budget.cancel({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: 2,
    });
    await expect(
      budget.settle({
        network: input.network,
        organizationId: input.organizationId,
        projectId: input.projectId,
        hourBucket: input.hourBucket,
        dayBucket: input.dayBucket,
        reservationId: input.reservationId,
        attempt: 2,
        reservedLamports: input.amount,
        actualLamports: 0,
      })
    ).rejects.toThrow("counter invariant");

    expect(await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "global")).toBe(
      "5"
    );
  });

  it("cancels a missing standalone reservation without touching an equal concurrent marker", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_cancel_missing",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    await raw.del("sdp:sponsorship:{devnet}:reservation:reservation_cancel_missing:1");
    await expect(
      budget.reserve({ ...input, reservationId: "reservation_cancel_concurrent" })
    ).resolves.toBe("admitted");

    await budget.cancel({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: input.attempt,
    });

    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:reservation_cancel_missing:1")).toBeNull();
    expect(await raw.hget(hourKey, "__reservation:reservation_cancel_concurrent:1")).toBe("5");
    expect(
      await raw.get("sdp:sponsorship:{devnet}:reservation:reservation_cancel_concurrent:1")
    ).toBe("5");
  });

  it("recovers a durably-authorized settlement after its Redis reservation expires", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_expired",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    const reservationKey = "sdp:sponsorship:{devnet}:reservation:reservation_expired:1";
    const settlementKey = "sdp:sponsorship:{devnet}:settlement:reservation_expired:1";
    await raw.del(reservationKey);
    const settlement = {
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: input.attempt,
      reservedLamports: input.amount,
      actualLamports: 2,
    };

    await expect(budget.settle(settlement)).rejects.toThrow("counter invariant");
    await expect(budget.settle({ ...settlement, detectMissingReservation: true })).resolves.toBe(
      -3
    );
    await expect(budget.settle({ ...settlement, detectMissingReservation: true })).resolves.toBe(0);

    expect(await raw.get(settlementKey)).toBe("2");
    expect(await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "global")).toBe(
      "2"
    );
    expect(
      await raw.hget(
        "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z",
        "__reservation:reservation_expired:1"
      )
    ).toBeNull();
  });

  it("recovers only the missing attempt without erasing a concurrent reservation", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_missing",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    await raw.del("sdp:sponsorship:{devnet}:reservation:reservation_missing:1");
    await expect(
      budget.reserve({ ...input, reservationId: "reservation_concurrent", amount: 3 })
    ).resolves.toBe("admitted");

    await expect(
      budget.settle({
        network: input.network,
        organizationId: input.organizationId,
        projectId: input.projectId,
        hourBucket: input.hourBucket,
        dayBucket: input.dayBucket,
        reservationId: input.reservationId,
        attempt: input.attempt,
        reservedLamports: input.amount,
        actualLamports: 2,
        detectMissingReservation: true,
      })
    ).resolves.toBe(-3);

    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "organization:org_1")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:reservation_missing:1")).toBeNull();
    expect(await raw.hget(hourKey, "__reservation:reservation_concurrent:1")).toBe("3");
    expect(await raw.get("sdp:sponsorship:{devnet}:reservation:reservation_concurrent:1")).toBe(
      "3"
    );
  });

  it("does not re-apply a recovered settlement to counters rebuilt from durable usage", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_rebuilt",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    await raw.del("sdp:sponsorship:{devnet}:reservation:reservation_rebuilt:1", hourKey, dayKey);
    const rebuiltUsage = {
      hour: { global: 2, organization: 2, project: 0 },
      day: { global: 2, organization: 2, project: 0 },
    };
    await expect(
      budget.reserve({
        ...input,
        reservationId: "reservation_after_rebuild",
        amount: 3,
        usage: rebuiltUsage,
      })
    ).resolves.toBe("admitted");

    await expect(
      budget.settle({
        network: input.network,
        organizationId: input.organizationId,
        projectId: input.projectId,
        hourBucket: input.hourBucket,
        dayBucket: input.dayBucket,
        reservationId: input.reservationId,
        attempt: input.attempt,
        reservedLamports: input.amount,
        actualLamports: 2,
        detectMissingReservation: true,
      })
    ).resolves.toBe(-3);

    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(dayKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:reservation_rebuilt:1")).toBeNull();
    expect(await raw.hget(hourKey, "__reservation:reservation_after_rebuild:1")).toBe("3");
  });

  it("restores a live reservation marker so partial reconstruction settles both counters consistently", async () => {
    const base = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
    };
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";

    await expect(
      budget.reserve({
        ...base,
        reservationId: "reservation_partial",
        attempt: 1,
        amount: 5,
        usage: EMPTY_USAGE,
        liveReservations: { hour: [], day: [] },
      })
    ).resolves.toBe("admitted");

    await raw.del(hourKey, "sdp:sponsorship:{devnet}:reservation:reservation_partial:1");

    await expect(
      budget.reserve({
        ...base,
        reservationId: "reservation_other",
        attempt: 1,
        amount: 3,
        usage: {
          hour: { global: 5, organization: 5, project: 0 },
          day: { global: 5, organization: 5, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "reservation_partial",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "reservation_partial",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("8");
    expect(await raw.hget(dayKey, "global")).toBe("8");
    expect(await raw.hget(hourKey, "__reservation:reservation_partial:1")).toBe("5");

    await expect(
      budget.settle({
        network: base.network,
        organizationId: base.organizationId,
        projectId: base.projectId,
        hourBucket: base.hourBucket,
        dayBucket: base.dayBucket,
        reservationId: "reservation_partial",
        attempt: 1,
        reservedLamports: 5,
        actualLamports: 2,
        detectMissingReservation: true,
      })
    ).resolves.toBe(-3);

    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(dayKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:reservation_partial:1")).toBeNull();
    expect(await raw.hget(dayKey, "__reservation:reservation_partial:1")).toBeNull();
  });

  it("settles a reservation whose scope field a cross-tenant rebuild never initialized", async () => {
    const hourBucket = "2026-08-03T10:00:00.000Z";
    const dayBucket = "2026-08-03T00:00:00.000Z";
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const policies = [policy("global", 1, true, 20), policy("organization", 1, true, 20)];

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_b",
        projectId: null,
        hourBucket,
        dayBucket,
        reservationId: "res_b",
        attempt: 1,
        amount: 5,
        policies,
        usage: EMPTY_USAGE,
        liveReservations: { hour: [], day: [] },
      })
    ).resolves.toBe("admitted");

    await raw.del(hourKey, "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z");
    await raw.del("sdp:sponsorship:{devnet}:reservation:res_b:1");

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_a",
        projectId: null,
        hourBucket,
        dayBucket,
        reservationId: "res_a",
        attempt: 1,
        amount: 3,
        policies,
        usage: {
          hour: { global: 5, organization: 0, project: 0 },
          day: { global: 5, organization: 0, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_b",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_b",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_b",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_b",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("8");
    expect(await raw.hget(hourKey, "__initialized:organization:org_b")).toBeNull();
    expect(await raw.hget(hourKey, "__reservation:res_b:1")).toBe("5");

    await expect(
      budget.settle({
        network: "devnet",
        organizationId: "org_b",
        projectId: null,
        hourBucket,
        dayBucket,
        reservationId: "res_b",
        attempt: 1,
        reservedLamports: 5,
        actualLamports: 2,
        detectMissingReservation: true,
      })
    ).resolves.toBe(-3);

    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:res_b:1")).toBeNull();
  });

  it("does not re-count a reservation of the previous ownership format on retry", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    for (const key of [hourKey, dayKey]) {
      await raw.hset(
        key,
        "global",
        "10",
        "__initialized:global",
        "1",
        "organization:org_1",
        "10",
        "__initialized:organization:org_1",
        "1",
        "__reservation:res_legacy_retry:1",
        "10"
      );
    }

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_legacy_retry",
        attempt: 1,
        amount: 10,
        policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
        usage: {
          hour: { global: 10, organization: 10, project: 0 },
          day: { global: 10, organization: 10, project: 0 },
        },
        liveReservations: { hour: [], day: [] },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("10");
    expect(await raw.hget(hourKey, "organization:org_1")).toBe("10");
    expect(await raw.hget(dayKey, "global")).toBe("10");
  });

  it("settles a reservation left behind by the previous ownership format", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    for (const key of [hourKey, dayKey]) {
      await raw.hset(
        key,
        "global",
        "10",
        "__initialized:global",
        "1",
        "organization:org_1",
        "10",
        "__initialized:organization:org_1",
        "1",
        "__reservation:res_legacy:1",
        "10"
      );
    }

    await expect(
      budget.settle({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_legacy",
        attempt: 1,
        reservedLamports: 10,
        actualLamports: 4,
        detectMissingReservation: true,
      })
    ).resolves.toBe(-6);

    expect(await raw.hget(hourKey, "global")).toBe("4");
    expect(await raw.hget(hourKey, "organization:org_1")).toBe("4");
    expect(await raw.hget(dayKey, "global")).toBe("4");
    expect(await raw.hget(hourKey, "__reservation:res_legacy:1")).toBeNull();
  });

  it("cancels a reservation left behind by the previous ownership format", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    for (const key of [hourKey, dayKey]) {
      await raw.hset(
        key,
        "global",
        "10",
        "__initialized:global",
        "1",
        "organization:org_1",
        "10",
        "__initialized:organization:org_1",
        "1",
        "__reservation:res_legacy_cancel:1",
        "10"
      );
    }

    await budget.cancel({
      network: "devnet",
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "res_legacy_cancel",
      attempt: 1,
    });

    expect(await raw.hget(hourKey, "global")).toBe("0");
    expect(await raw.hget(dayKey, "organization:org_1")).toBe("0");
    expect(await raw.hget(hourKey, "__reservation:res_legacy_cancel:1")).toBeNull();
  });

  it("counts a tenant once when its field is seeded into an already warm window", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const policies = [policy("global", 1, true, 1000), policy("organization", 1, true, 1000)];
    const window = {
      network: "devnet" as const,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      projectId: null,
      policies,
    };

    await expect(
      budget.reserve({
        ...window,
        organizationId: "org_a",
        reservationId: "res_a",
        attempt: 1,
        amount: 5,
        usage: EMPTY_USAGE,
        liveReservations: { hour: [], day: [] },
      })
    ).resolves.toBe("admitted");

    const liveB2 = {
      id: "res_b2",
      attempt: 1,
      reservedLamports: 10,
      organizationId: "org_b",
      projectId: null,
    };
    await expect(
      budget.reserve({
        ...window,
        organizationId: "org_b",
        reservationId: "res_b1",
        attempt: 1,
        amount: 10,
        usage: {
          hour: { global: 15, organization: 10, project: 0 },
          day: { global: 15, organization: 10, project: 0 },
        },
        liveReservations: { hour: [liveB2], day: [liveB2] },
      })
    ).resolves.toBe("admitted");

    const liveB1 = {
      id: "res_b1",
      attempt: 1,
      reservedLamports: 10,
      organizationId: "org_b",
      projectId: null,
    };
    await expect(
      budget.reserve({
        ...window,
        organizationId: "org_b",
        reservationId: "res_b2",
        attempt: 1,
        amount: 10,
        usage: {
          hour: { global: 15, organization: 10, project: 0 },
          day: { global: 15, organization: 10, project: 0 },
        },
        liveReservations: { hour: [liveB1], day: [liveB1] },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "organization:org_b")).toBe("20");
  });

  it("denies an adopted reservation that exceeds the per-transaction limit", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_self",
        attempt: 1,
        amount: 11,
        policies: [policy("global", 1, true, 10), policy("organization", 1, true, 10)],
        usage: {
          hour: { global: 11, organization: 11, project: 0 },
          day: { global: 11, organization: 11, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_self",
              attempt: 1,
              reservedLamports: 11,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_self",
              attempt: 1,
              reservedLamports: 11,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("denied");

    expect(await raw.get("sdp:sponsorship:{devnet}:reservation:res_self:1")).toBeNull();
    expect(await raw.hget(hourKey, "global")).toBe("11");
  });

  it("denies an adopted reservation once the seeded window already exceeds its limit", async () => {
    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_over",
        attempt: 1,
        amount: 5,
        policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
        usage: {
          hour: { global: 25, organization: 25, project: 0 },
          day: { global: 25, organization: 25, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_over",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_over",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("denied");
  });

  it("adopts a reconstruction-seeded reservation instead of double-counting its own reserve", async () => {
    const base = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
    };
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";

    await expect(
      budget.reserve({
        ...base,
        reservationId: "reservation_a",
        attempt: 1,
        amount: 5,
        usage: {
          hour: { global: 8, organization: 8, project: 0 },
          day: { global: 8, organization: 8, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "reservation_b",
              attempt: 1,
              reservedLamports: 8,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "reservation_b",
              attempt: 1,
              reservedLamports: 8,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("13");
    expect(await raw.hget(hourKey, "__reservation:reservation_b:1")).toBe("8");

    await expect(
      budget.reserve({
        ...base,
        reservationId: "reservation_b",
        attempt: 1,
        amount: 8,
        usage: {
          hour: { global: 13, organization: 13, project: 0 },
          day: { global: 13, organization: 13, project: 0 },
        },
        liveReservations: { hour: [], day: [] },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("13");
    expect(await raw.hget(dayKey, "global")).toBe("13");
    expect(await raw.get("sdp:sponsorship:{devnet}:reservation:reservation_b:1")).toBe("8");
  });

  it("fills the missing counter when only one window was seeded during adoption", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    await raw.hset(
      dayKey,
      "global",
      "0",
      "__initialized:global",
      "1",
      "organization:org_1",
      "0",
      "__initialized:organization:org_1",
      "1"
    );

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_a",
        attempt: 1,
        amount: 4,
        policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
        usage: {
          hour: { global: 4, organization: 4, project: 0 },
          day: { global: 4, organization: 4, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_a",
              attempt: 1,
              reservedLamports: 4,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_a",
              attempt: 1,
              reservedLamports: 4,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("4");
    expect(await raw.hget(dayKey, "global")).toBe("4");
    expect(await raw.hget(dayKey, "__reservation:res_a:1")).toBe("4");
    expect(await raw.hget(hourKey, "__reservation:res_a:1")).toBe("4");
  });

  it("enforces the daily limit on the window it must fill during adoption", async () => {
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    await raw.hset(
      dayKey,
      "global",
      "98",
      "__initialized:global",
      "1",
      "organization:org_1",
      "98",
      "__initialized:organization:org_1",
      "1"
    );

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_a",
        attempt: 1,
        amount: 4,
        policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
        usage: {
          hour: { global: 4, organization: 4, project: 0 },
          day: { global: 98, organization: 98, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_a",
              attempt: 1,
              reservedLamports: 4,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_a",
              attempt: 1,
              reservedLamports: 4,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("denied");

    expect(await raw.hget(dayKey, "global")).toBe("98");
    expect(await raw.hget(dayKey, "__reservation:res_a:1")).toBeNull();
    expect(await raw.get("sdp:sponsorship:{devnet}:reservation:res_a:1")).toBeNull();
  });

  it("corrects a reservation that settled between the snapshot and reconstruction", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    const dayKey = "sdp:sponsorship:{devnet}:day:2026-08-03T00:00:00.000Z";
    await raw.set("sdp:sponsorship:{devnet}:settlement:res_c:1", "2");

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_1",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_a",
        attempt: 1,
        amount: 3,
        policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
        usage: {
          hour: { global: 5, organization: 5, project: 0 },
          day: { global: 5, organization: 5, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_c",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_c",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_1",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "organization:org_1")).toBe("5");
    expect(await raw.hget(dayKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "__reservation:res_c:1")).toBeNull();
  });

  it("corrects a cross-tenant reservation that settled mid-snapshot without initializing its scope", async () => {
    const hourKey = "sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z";
    await raw.set("sdp:sponsorship:{devnet}:settlement:res_b:1", "2");

    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: "org_a",
        projectId: null,
        hourBucket: "2026-08-03T10:00:00.000Z",
        dayBucket: "2026-08-03T00:00:00.000Z",
        reservationId: "res_a",
        attempt: 1,
        amount: 3,
        policies: [policy("global", 1, true, 100), policy("organization", 1, true, 100)],
        usage: {
          hour: { global: 5, organization: 0, project: 0 },
          day: { global: 5, organization: 0, project: 0 },
        },
        liveReservations: {
          hour: [
            {
              id: "res_b",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_b",
              projectId: null,
            },
          ],
          day: [
            {
              id: "res_b",
              attempt: 1,
              reservedLamports: 5,
              organizationId: "org_b",
              projectId: null,
            },
          ],
        },
      })
    ).resolves.toBe("admitted");

    expect(await raw.hget(hourKey, "global")).toBe("5");
    expect(await raw.hget(hourKey, "organization:org_a")).toBe("3");
    expect(await raw.hget(hourKey, "__initialized:organization:org_b")).toBeNull();
    expect(await raw.hget(hourKey, "__reservation:res_b:1")).toBeNull();
  });

  it("rejects settlement when an existing reservation has the wrong amount", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_mismatch",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await expect(budget.reserve(input)).resolves.toBe("admitted");
    await raw.set("sdp:sponsorship:{devnet}:reservation:reservation_mismatch:1", "4");

    await expect(
      budget.settle({
        network: input.network,
        organizationId: input.organizationId,
        projectId: input.projectId,
        hourBucket: input.hourBucket,
        dayBucket: input.dayBucket,
        reservationId: input.reservationId,
        attempt: input.attempt,
        reservedLamports: input.amount,
        actualLamports: 2,
        detectMissingReservation: true,
      })
    ).rejects.toThrow("counter invariant");
  });

  it("keeps stale callbacks from undoing a newer retry attempt", async () => {
    const input = {
      network: "devnet" as const,
      organizationId: "org_1",
      projectId: null,
      hourBucket: "2026-08-03T10:00:00.000Z",
      dayBucket: "2026-08-03T00:00:00.000Z",
      reservationId: "reservation_retry",
      attempt: 1,
      amount: 5,
      policies: [policy("global", 1, true, 20), policy("organization", 1, true, 20)],
      usage: EMPTY_USAGE,
    };
    await budget.reserve(input);
    await budget.settle({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: 1,
      reservedLamports: input.amount,
      actualLamports: 0,
    });
    await expect(budget.reserve({ ...input, attempt: 2 })).resolves.toBe("admitted");

    await budget.cancel({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: 1,
    });
    await budget.settle({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
      reservationId: input.reservationId,
      attempt: 1,
      reservedLamports: input.amount,
      actualLamports: 0,
    });

    expect(await raw.hget("sdp:sponsorship:{devnet}:hour:2026-08-03T10:00:00.000Z", "global")).toBe(
      "5"
    );
  });
});
