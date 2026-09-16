import { describe, expect, it, vi } from "vitest";
import type { PolicyRepository } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { PostgresPolicyEnforcementStore } from "./enforcement.store";

describe("PostgresPolicyEnforcementStore.loadVelocityObservations", () => {
  it("measures distinct keys in parallel under the cap, de-duplicated, in rule order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const repository = {
      sumWalletOperationAmounts: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return "1";
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
        { kind: "velocity", window: "P1D", max: "1", assets: ["A", "B", "C", "D"] },
        // A repeated key measures once; an unparsable window measures never.
        { kind: "velocity", window: "P1D", max: "1", assets: ["A", "B", "C", "D"] },
        { kind: "velocity", window: "P1W", max: "1", assets: ["A", "B", "C", "D"] },
        {
          kind: "velocity",
          scope: "organization",
          window: "PT1H",
          max: "1",
          assets: ["A", "B", "C", "D"],
        },
      ]
    );

    expect(repository.sumWalletOperationAmounts).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(observations.map((observation) => `${observation.scope}|${observation.asset}`)).toEqual([
      "wallet|A",
      "wallet|B",
      "wallet|C",
      "wallet|D",
      "organization|A",
      "organization|B",
      "organization|C",
      "organization|D",
    ]);
    expect(observations.every((observation) => observation.total === "1")).toBe(true);
  });
});
