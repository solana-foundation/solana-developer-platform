import { describe, expect, it, vi } from "vitest";
import {
  currentDatabaseIdentity,
  runWithoutDatabaseIdentity,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db/identity";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import {
  currentMandateActivator,
  currentMoneyPrincipal,
  type MoneyPrincipal,
  moneyPrincipalSchema,
  runAsMoneyPrincipal,
  runAsRecordedMoneyPrincipal,
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

function recordedTransfer(principal: MoneyPrincipal | null): PaymentTransferRow {
  return {
    id: "xfr_recorded_principal",
    organization_id: "org_recorded_principal",
    project_id: "prj_recorded_principal",
    custody_wallet_id: "cw_recorded_principal",
    wallet_id: "fb_0",
    counterparty_id: null,
    source_address: null,
    destination_address: null,
    token: "SOL",
    amount: "1",
    memo: null,
    type: "transfer",
    kind: "pay",
    direction: "outbound",
    status: "processing",
    provider: null,
    provider_reference: null,
    provider_observed_at: null,
    delivery_mode: null,
    fiat_currency: null,
    fiat_amount: null,
    ramps_memo: {},
    provider_data: {},
    signature: null,
    serialized_tx: null,
    signed_transaction: null,
    last_valid_block_height: null,
    submission_started_at: null,
    slot: null,
    block_time: null,
    fee: null,
    error: null,
    initiated_by_key_id: "audit_identity_is_not_authority",
    initiated_by_principal: principal,
    idempotency_key: null,
    idempotency_fingerprint: null,
    confirmed_at: null,
    finalization_last_polled_at: null,
    audit_intent_id: null,
    created_at: "2026-11-11T00:00:00.000Z",
    updated_at: "2026-11-11T00:00:00.000Z",
  };
}

function asRecoveryWorker<T>(fn: () => T): T {
  return runWithSystemDatabaseIdentity("cron:reconcile-custody-proposals", fn);
}

describe("runAsRecordedMoneyPrincipal", () => {
  it.each(PRINCIPALS)("restores only the recorded $kind identity", (principal) => {
    const row = recordedTransfer(principal);
    asRecoveryWorker(() => {
      const result = runAsRecordedMoneyPrincipal(row, () => {
        const restored = currentMoneyPrincipal();
        expect(restored).toEqual(principal);
        expect(restored).not.toBe(row.initiated_by_principal);
        expect(Object.isFrozen(restored)).toBe(true);
        expect(currentDatabaseIdentity()).toEqual({
          kind: "system",
          component: "cron:reconcile-custody-proposals",
        });
        return "recovered";
      });
      expect(result).toBe("recovered");
      expect(currentMoneyPrincipal()).toBeNull();
    });
  });

  it.each([
    null,
    undefined,
    {},
    { kind: "api_key", apiKeyId: 42 },
    { kind: "member", userId: " " },
    { kind: "api_key", apiKeyId: "key_1", grants: ["transfers.execute"] },
    { kind: "member", userId: "user_1", role: "admin" },
    { kind: "mandate", recurringPaymentId: "mandate_1", walletScope: "all" },
  ])("refuses absent or malformed recorded authority %j", (principal) => {
    const row = recordedTransfer(null);
    // Simulate a malformed durable value without weakening the production row type.
    Object.defineProperty(row, "initiated_by_principal", { value: principal });
    const recover = vi.fn();
    asRecoveryWorker(() => {
      expect(() => runAsRecordedMoneyPrincipal(row, recover)).toThrow(
        new AppError("INTERNAL_ERROR", "Transfer has no valid recorded money principal")
      );
      expect(currentMoneyPrincipal()).toBeNull();
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses HTTP, unrelated workloads and work without database authority", () => {
    const row = recordedTransfer(PRINCIPALS[0]);
    const recover = vi.fn();
    const attempt = () => {
      expect(() => runAsRecordedMoneyPrincipal(row, recover)).toThrow(
        "Recorded money principals require the recovery worker"
      );
    };
    for (const principal of [PRINCIPALS[0], PRINCIPALS[1]]) {
      runWithTenantDatabaseIdentity({ organizationId: row.organization_id }, () =>
        runAsMoneyPrincipal(principal, attempt)
      );
    }
    runWithSystemDatabaseIdentity("cron:another-job", attempt);
    runWithoutDatabaseIdentity("test:recorded-principal", attempt);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(PRINCIPALS)(
    "refuses an inherited $kind principal even with the worker identity",
    (principal) => {
      const recover = vi.fn();
      runAsMoneyPrincipal(principal, () => {
        asRecoveryWorker(() => {
          expect(() =>
            runAsRecordedMoneyPrincipal(recordedTransfer(PRINCIPALS[0]), recover)
          ).toThrow("A money principal is already set for this work");
        });
        expect(currentMoneyPrincipal()).toEqual(principal);
      });
      expect(recover).not.toHaveBeenCalled();
      expect(currentMoneyPrincipal()).toBeNull();
    }
  );

  it("isolates simultaneous worker identities", async () => {
    await Promise.all(
      PRINCIPALS.map((principal) =>
        asRecoveryWorker(() =>
          runAsRecordedMoneyPrincipal(recordedTransfer(principal), async () => {
            await Promise.resolve();
            expect(currentMoneyPrincipal()).toEqual(principal);
          })
        )
      )
    );
    expect(currentMoneyPrincipal()).toBeNull();
  });

  it("cleans up the worker context when recovery throws or rejects", async () => {
    const row = recordedTransfer(PRINCIPALS[0]);
    asRecoveryWorker(() => {
      expect(() =>
        runAsRecordedMoneyPrincipal(row, () => {
          throw new Error("sync recovery failed");
        })
      ).toThrow("sync recovery failed");
    });
    await expect(
      asRecoveryWorker(() =>
        runAsRecordedMoneyPrincipal(row, async () => {
          await Promise.resolve();
          throw new Error("async recovery failed");
        })
      )
    ).rejects.toThrow("async recovery failed");
    expect(currentMoneyPrincipal()).toBeNull();
  });
});
