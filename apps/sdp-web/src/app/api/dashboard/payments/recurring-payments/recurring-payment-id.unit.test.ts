import { describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getTranslations: async () => (key: MessageKey) => translate(getMessages("en"), key),
  };
});

import { readRecurringPaymentId } from "./recurring-payment-id";

describe("readRecurringPaymentId", () => {
  it("decodes the segment Next hands over still encoded, once", async () => {
    await expect(
      readRecurringPaymentId({ params: Promise.resolve({ recurringPaymentId: "prp%2F1" }) })
    ).resolves.toEqual({ ok: true, recurringPaymentId: "prp/1" });
  });

  it("answers 400 with the schedule id copy for a malformed segment", async () => {
    const id = await readRecurringPaymentId({
      params: Promise.resolve({ recurringPaymentId: "prp%E0%A4%A" }),
    });
    if (id.ok) throw new Error("a malformed id was read");

    expect(id.response.status).toBe(400);
    expect(await id.response.json()).toEqual({ error: { message: "Invalid schedule ID." } });
  });
});
