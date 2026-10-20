import { afterEach, describe, expect, it, vi } from "vitest";
import * as collectRecurringPaymentsModule from "@/services/jobs/collect-recurring-payments";
import { env } from "@/test/helpers/env";
import { recurringPaymentsCron } from "./recurring-payments";

describe("recurringPaymentsCron", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects the payments due at the moment the slot runs", async () => {
    const now = new Date("2026-10-19T12:05:00.000Z");
    vi.useFakeTimers({ now });
    const collect = vi
      .spyOn(collectRecurringPaymentsModule, "collectDueRecurringPayments")
      .mockResolvedValue({ recovered: 0, collected: 0, failed: 0, skipped: 0, refused: 0 });

    await recurringPaymentsCron.run(env);

    expect(collect).toHaveBeenCalledExactlyOnceWith(env, now);
  });
});
