import { describe, expect, it, vi } from "vitest";
import type { PolicyRepository } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { PostgresPolicyEnforcementStore } from "./enforcement.store";

const ASSETS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

describe("PostgresPolicyEnforcementStore.loadVelocityObservations", () => {
  it("measures distinct keys in parallel under the cap, de-duplicated, in rule order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let picked = 0;
    const repository = {
      sumWalletOperationAmounts: vi.fn(async (input: { scope: string; asset: string }) => {
        picked += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // The first keys picked finish last, so totals resolve well out of
        // start order while results must stay in rule order.
        await new Promise((resolve) => setTimeout(resolve, (ASSETS.length * 2 + 2 - picked) * 2));
        inFlight -= 1;
        return `${input.asset}:${input.scope}`;
      }),
    } as unknown as PolicyRepository;

    const store = new PostgresPolicyEnforcementStore(
      repository,
      createTenantScope({ organizationId: "org_1", projectId: "prj_1" })
    );

    const observations = await store.loadVelocityObservations(
      {
        organizationId: "org_1",
        projectId: "prj_1",
        custodyWalletId: "cw_1",
        walletId: "wal_1",
        apiKeyId: null,
      },
      [
        { kind: "velocity", window: "P1D", max: "1", assets: ASSETS },
        // A repeated key measures once; an unparsable window measures never.
        { kind: "velocity", window: "P1D", max: "1", assets: ASSETS },
        { kind: "velocity", window: "P1W", max: "1", assets: ASSETS },
        {
          kind: "velocity",
          scope: "organization",
          window: "PT1H",
          max: "1",
          assets: ASSETS,
        },
      ]
    );

    expect(repository.sumWalletOperationAmounts).toHaveBeenCalledTimes(ASSETS.length * 2);
    // Twenty-four distinct keys run through exactly eight workers: an
    // unbounded Promise.all would open every sum at once and drive this to
    // twenty-four, a sequential loop would hold it at one.
    expect(maxInFlight).toBe(8);
    expect(observations.map((observation) => `${observation.scope}|${observation.asset}`)).toEqual(
      ASSETS.map((asset) => `wallet|${asset}`).concat(
        ASSETS.map((asset) => `organization|${asset}`)
      )
    );
    // Distinct totals attach to their own key despite out-of-order completion.
    expect(
      observations.every(
        (observation) => observation.total === `${observation.asset}:${observation.scope}`
      )
    ).toBe(true);
  });

  it("stops measuring the remaining keys once one sum fails", async () => {
    const repository = {
      sumWalletOperationAmounts: vi.fn((input: { asset: string }) => {
        if (input.asset === "A") {
          // The first key picked fails before any other sum can resolve.
          return Promise.reject(new Error("sum failed"));
        }
        return new Promise<string>((resolve) => setTimeout(resolve, 1, "0"));
      }),
    } as unknown as PolicyRepository;

    const store = new PostgresPolicyEnforcementStore(
      repository,
      createTenantScope({ organizationId: "org_1", projectId: "prj_1" })
    );

    // More distinct keys than the cap: after the failure the workers must
    // stop taking new sums instead of draining the rest of the queue.
    await expect(
      store.loadVelocityObservations(
        {
          organizationId: "org_1",
          projectId: "prj_1",
          custodyWalletId: "cw_1",
          walletId: "wal_1",
          apiKeyId: null,
        },
        [{ kind: "velocity", window: "P1D", max: "1", assets: ASSETS }]
      )
    ).rejects.toThrow("sum failed");
    // Leave time for a leaky pool to drain the queue it should have dropped.
    await new Promise((resolve) => setTimeout(resolve, ASSETS.length * 4));
    expect(repository.sumWalletOperationAmounts).toHaveBeenCalledTimes(8);
  });
});
