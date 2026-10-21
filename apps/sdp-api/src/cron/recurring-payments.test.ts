import { afterEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "@/runtime/logger";
import * as collectRecurringPaymentsModule from "@/services/jobs/collect-recurring-payments";
import { env } from "@/test/helpers/env";
import { recurringPaymentsCron } from "./recurring-payments";

describe("recurringPaymentsCron", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects the payments due at the moment the slot runs and logs the tick's counts", async () => {
    const now = new Date("2026-10-19T12:05:00.000Z");
    vi.useFakeTimers({ now });
    const result = { recovered: 1, collected: 2, failed: 0, skipped: 3, refused: 0 };
    const collect = vi
      .spyOn(collectRecurringPaymentsModule, "collectDueRecurringPayments")
      .mockResolvedValue(result);
    const info = vi.spyOn(rootLogger, "info").mockImplementation(() => undefined);

    await recurringPaymentsCron.run(env);

    expect(collect).toHaveBeenCalledExactlyOnceWith(env, now);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      result,
      "collectDueRecurringPayments: tick finished"
    );
  });
});
