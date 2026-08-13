import type { RampSettlementEvent } from "@sdp/payments/ramps";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { PaymentsRepository } from "@/db/repositories";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { AppContext } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

const { notifyRampSettledMock, emitRampSettledMock, paymentsRepoWrap } = vi.hoisted(() => ({
  notifyRampSettledMock: vi.fn(),
  emitRampSettledMock: vi.fn(),
  // Lets a test intercept the guarded update to simulate a concurrent writer landing
  // between the pre-read and the claim — the interleave that can't be forced otherwise.
  paymentsRepoWrap: {
    current: null as null | ((repo: PaymentsRepository) => PaymentsRepository),
  },
}));

vi.mock("@/services/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/notifications")>()),
  notifyRampSettled: notifyRampSettledMock,
}));

vi.mock("@/services/workflows/payment-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/workflows/payment-events")>()),
  emitRampSettled: emitRampSettledMock,
}));

vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createSystemPaymentsRepository: (
      repoEnv: Parameters<typeof actual.createSystemPaymentsRepository>[0]
    ) => {
      const real = actual.createSystemPaymentsRepository(repoEnv);
      return paymentsRepoWrap.current ? paymentsRepoWrap.current(real) : real;
    },
  };
});

const ORG_ID = "org_ramp_settlement_test";
const PROJECT_ID = "prj_ramp_settlement_test";
const USER_ID = "usr_ramp_settlement_test";

function context(): AppContext {
  return { env } as unknown as AppContext;
}

async function seedTransfer(input: {
  id: string;
  reference: string;
  status: string;
  type?: "onramp" | "offramp" | "transfer";
  projectId?: string | null;
}) {
  const type = input.type ?? "onramp";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
         initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      ORG_ID,
      input.projectId === undefined ? PROJECT_ID : input.projectId,
      "wallet_ramp_settlement_test",
      type === "offramp" ? "source" : null,
      type === "onramp" ? "destination" : "destination",
      "USDC",
      "10",
      null,
      type,
      type === "onramp" ? "inbound" : "outbound",
      input.status,
      "coinbase",
      input.reference,
      "hosted",
      "USD",
      "10",
      {},
      null,
      null,
      null,
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z"
    )
    .run();
}

async function readTransfer(id: string) {
  return getDb(env)
    .prepare(
      "SELECT status, amount, fiat_amount, error, provider_data FROM payment_transfers WHERE id = ?"
    )
    .bind(id)
    .first<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      error: string | null;
      provider_data: Record<string, unknown>;
    }>();
}

describe("applyRampSettlementEvent", () => {
  beforeEach(async () => {
    notifyRampSettledMock.mockReset();
    emitRampSettledMock.mockReset();
    paymentsRepoWrap.current = null;
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG_ID, "Ramp Settlement Test", "ramp-settlement-test", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "ramp-settlement@example.com", 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          PROJECT_ID,
          ORG_ID,
          "Ramp Settlement Project",
          "ramp-settlement-project",
          "sandbox",
          "active",
          USER_ID
        ),
    ]);
  });

  it("never reopens a canceled transfer", async () => {
    await seedTransfer({ id: "xfr_canceled", reference: "order_canceled", status: "canceled" });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "settled",
      reference: "order_canceled",
      receivedAmount: "12",
    });

    expect(await readTransfer("xfr_canceled")).toMatchObject({
      status: "canceled",
      amount: "10",
    });
  });

  it("does not regress a settling transfer on an out-of-order event", async () => {
    await seedTransfer({ id: "xfr_settling", reference: "order_settling", status: "settling" });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "awaiting_payment",
      reference: "order_settling",
    });

    expect(await readTransfer("xfr_settling")).toMatchObject({ status: "settling" });
  });

  it("serializes concurrent terminal events", async () => {
    await seedTransfer({ id: "xfr_race", reference: "order_race", status: "settling" });
    const events: RampSettlementEvent[] = [
      { provider: "coinbase", kind: "settled", reference: "order_race", receivedAmount: "9" },
      { provider: "coinbase", kind: "failed", reference: "order_race", error: "declined" },
    ];

    await Promise.all(events.map((event) => applyRampSettlementEvent(context(), event)));

    const transfer = await readTransfer("xfr_race");
    expect(["completed", "failed"]).toContain(transfer?.status);
    if (transfer?.status === "completed") {
      expect(transfer.amount).toBe("9");
      expect(transfer.error).toBeNull();
    } else {
      expect(transfer?.amount).toBe("10");
      expect(transfer?.error).toBe("declined");
    }
  });

  it("makes exact retries idempotent", async () => {
    await seedTransfer({ id: "xfr_retry", reference: "order_retry", status: "settling" });
    const event: RampSettlementEvent = {
      provider: "coinbase",
      kind: "settled",
      reference: "order_retry",
      receivedAmount: "9",
    };

    await applyRampSettlementEvent(context(), event);
    await applyRampSettlementEvent(context(), { ...event, receivedAmount: "999" });

    expect(await readTransfer("xfr_retry")).toMatchObject({
      status: "completed",
      amount: "9",
    });
  });

  it("emits and notifies exactly once per settlement, replay included", async () => {
    await seedTransfer({ id: "xfr_signal", reference: "order_signal", status: "settling" });
    const event: RampSettlementEvent = {
      provider: "coinbase",
      kind: "settled",
      reference: "order_signal",
      receivedAmount: "9",
    };

    await applyRampSettlementEvent(context(), event);
    await applyRampSettlementEvent(context(), event);

    expect(emitRampSettledMock).toHaveBeenCalledTimes(1);
    expect(notifyRampSettledMock).toHaveBeenCalledTimes(1);
    expect(notifyRampSettledMock.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      transferId: "xfr_signal",
      direction: "onramp",
    });
  });

  it("fires no settlement signals when the guarded update loses the row", async () => {
    await seedTransfer({ id: "xfr_lost", reference: "order_lost", status: "settling" });
    // Simulate a concurrent `failed` committing between this handler's pre-read and
    // its guarded update: the pre-read saw `settling`, but the claim finds `failed`.
    paymentsRepoWrap.current = (real) => ({
      ...real,
      updateTransferStatusGuarded: async (input) => {
        await getDb(env)
          .prepare(
            "UPDATE payment_transfers SET status = 'failed', error = 'declined' WHERE id = ?"
          )
          .bind("xfr_lost")
          .run();
        return real.updateTransferStatusGuarded(input);
      },
    });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "settled",
      reference: "order_lost",
      receivedAmount: "9",
    });

    // The losing `settled` must not overwrite the terminal state, emit a workflow
    // event, or send the counterparty a "payment settled" receipt for a failed payment.
    expect(await readTransfer("xfr_lost")).toMatchObject({ status: "failed" });
    expect(emitRampSettledMock).not.toHaveBeenCalled();
    expect(notifyRampSettledMock).not.toHaveBeenCalled();
  });

  it("notifies admins for a project-less transfer without emitting a workflow event", async () => {
    await seedTransfer({
      id: "xfr_no_project",
      reference: "order_no_project",
      status: "settling",
      projectId: null,
    });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "settled",
      reference: "order_no_project",
      receivedAmount: "9",
    });

    // Workflow rules are project-scoped, so there is nothing to emit — but the
    // settlement itself is still org news.
    expect(emitRampSettledMock).not.toHaveBeenCalled();
    expect(notifyRampSettledMock).toHaveBeenCalledTimes(1);
    expect(notifyRampSettledMock.mock.calls[0]?.[1]).toMatchObject({
      projectId: null,
      transferId: "xfr_no_project",
    });
  });
});
