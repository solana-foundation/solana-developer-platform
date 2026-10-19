import { currentClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import * as collectRecurringPaymentsModule from "@/services/jobs/collect-recurring-payments";
import { env } from "@/test/helpers/env";
import { runRecurringPaymentsCollection } from "./recurring-payments";

describe("runRecurringPaymentsCollection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects once inside each environment's cluster scope", async () => {
    const scopedEnvironments: SdpEnvironment[] = [];
    vi.spyOn(collectRecurringPaymentsModule, "collectDueRecurringPayments").mockImplementation(
      async () => {
        scopedEnvironments.push(currentClusterScope().environment);
        return { recovered: 0, collected: 0, failed: 0, skipped: 0, refused: 0 };
      }
    );
    const runs: Promise<unknown>[] = [];
    const bg: BackgroundRunner = {
      run: (promise) => {
        runs.push(promise);
      },
      awaitAll: async () => {},
      draining: false,
    };

    runRecurringPaymentsCollection({ env, bg });
    await Promise.all(runs);

    expect(runs).toHaveLength(1);
    expect(scopedEnvironments).toHaveLength(SDP_ENVIRONMENTS.length);
    expect(new Set(scopedEnvironments)).toEqual(new Set(SDP_ENVIRONMENTS));
  });
});
