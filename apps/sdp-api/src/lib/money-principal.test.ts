import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  currentMandateActivator,
  currentMoneyPrincipal,
  type MoneyPrincipal,
  moneyPrincipalSchema,
  runAsMoneyPrincipal,
} from "./money-principal";

const PRINCIPALS = [
  { kind: "api_key", apiKeyId: "key_1" },
  { kind: "member", userId: "user_1" },
  { kind: "mandate", recurringPaymentId: "recurring_1" },
  { kind: "payment_request", paymentRequestId: "request_1" },
] as const satisfies readonly MoneyPrincipal[];

describe("moneyPrincipalSchema", () => {
  it.each(PRINCIPALS)("round-trips a persisted $kind identity", (principal) => {
    expect(moneyPrincipalSchema.parse(JSON.parse(JSON.stringify(principal)))).toEqual(principal);
  });

  it.each([
    null,
    undefined,
    "api_key",
    [],
    {},
    { kind: "system", id: "service_1" },
    { kind: "api_key", id: "key_1" },
    { kind: "api_key", apiKeyId: 42 },
    { kind: "member", apiKeyId: "key_1" },
    { kind: "mandate", recurringPaymentId: null },
    { kind: "payment_request" },
  ])("rejects malformed persisted identity %j", (value) => {
    expect(moneyPrincipalSchema.safeParse(value).success).toBe(false);
  });

  it.each(["", " ", "\t\n", "\u00a0", "\ufeff"])("rejects blank ids %j for every kind", (id) => {
    const invalid = [
      { kind: "api_key", apiKeyId: id },
      { kind: "member", userId: id },
      { kind: "mandate", recurringPaymentId: id },
      { kind: "payment_request", paymentRequestId: id },
    ];
    for (const principal of invalid) {
      expect(moneyPrincipalSchema.safeParse(principal).success).toBe(false);
    }
  });

  it.each(PRINCIPALS)("rejects extra identity and privilege fields for $kind", (principal) => {
    for (const extra of [
      { id: "another_identity" },
      { role: "admin" },
      { grants: ["transfers.execute"] },
      { walletScope: "all" },
    ]) {
      expect(moneyPrincipalSchema.safeParse({ ...principal, ...extra }).success).toBe(false);
    }
  });

  it("preserves a nonblank id verbatim", () => {
    const principal = { kind: "api_key", apiKeyId: " key_1 " } as const;
    expect(moneyPrincipalSchema.parse(principal)).toEqual(principal);
  });
});

describe("runAsMoneyPrincipal", () => {
  it("captures a frozen identity without retaining the caller's mutable object", () => {
    const principal = { kind: "api_key", apiKeyId: "key_original" } as const;
    const input = { kind: "api_key" as const, apiKeyId: "key_original" };
    runAsMoneyPrincipal(input, () => {
      const captured = currentMoneyPrincipal();
      expect(captured).not.toBe(input);
      expect(Object.isFrozen(captured)).toBe(true);
      input.apiKeyId = "key_changed";
      expect(currentMoneyPrincipal()).toEqual(principal);
    });
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("keeps the same identity when a matching principal re-enters", () => {
    const principal = PRINCIPALS[0];
    runAsMoneyPrincipal(principal, () => {
      const captured = currentMoneyPrincipal();
      runAsMoneyPrincipal({ ...principal }, () => {
        expect(currentMoneyPrincipal()).toBe(captured);
      });
    });
  });

  it("refuses a nested identity swap and retains the original context", () => {
    runAsMoneyPrincipal(PRINCIPALS[0], () => {
      expect(() => runAsMoneyPrincipal(PRINCIPALS[1], () => undefined)).toThrow(
        "A money principal is already set for this work"
      );
      expect(currentMoneyPrincipal()).toEqual(PRINCIPALS[0]);
    });
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it.each(["", " ", "\t\n", "\u00a0", "\ufeff"])("refuses a blank ambient id %j", (apiKeyId) => {
    expect(() => runAsMoneyPrincipal({ kind: "api_key", apiKeyId }, () => undefined)).toThrow(
      AppError
    );
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("isolates simultaneous asynchronous principals", async () => {
    await Promise.all(
      PRINCIPALS.map((principal) =>
        runAsMoneyPrincipal(principal, async () => {
          await Promise.resolve();
          expect(currentMoneyPrincipal()).toEqual(principal);
        })
      )
    );
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("keeps a mandate's identity separate from its activator", () => {
    expect(currentMandateActivator()).toBeNull();
    expect(runAsMoneyPrincipal(PRINCIPALS[0], currentMandateActivator)).toEqual({
      apiKeyId: "key_1",
      userId: null,
    });
    expect(runAsMoneyPrincipal(PRINCIPALS[1], currentMandateActivator)).toEqual({
      apiKeyId: null,
      userId: "user_1",
    });
    expect(runAsMoneyPrincipal(PRINCIPALS[2], currentMandateActivator)).toBeNull();
    expect(runAsMoneyPrincipal(PRINCIPALS[3], currentMandateActivator)).toBeNull();
  });
});
