import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type PaymentTransferStatus,
  type PaymentTransferType,
  RAMP_TRANSFER_STATUS_TERMINAL,
  RAMP_TRANSFER_TRANSITIONS,
  RAMP_TRANSFER_TYPES,
  type RampTransferTransitionId,
} from "@sdp/types/payments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import * as events from "@/runtime/money-path-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { applyRampSettlementEvent } from "./ramp-settlements";

const ORG_ID = "org_ramp_transitions_test";
const PROJECT_ID = "prj_ramp_transitions_test";
const USER_ID = "usr_ramp_transitions_test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

function sortedSources(transition: RampTransferTransitionId): PaymentTransferStatus[] {
  return [...RAMP_TRANSFER_TRANSITIONS[transition].from].sort();
}

async function seedTransfer(input: {
  id: string;
  status: PaymentTransferStatus;
  type: Exclude<PaymentTransferType, "transfer_batch">;
  reference?: string;
}) {
  const isRamp = input.type !== "transfer";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, type, direction, status, provider, provider_reference, delivery_mode,
         fiat_currency, fiat_amount, provider_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
    )
    .bind(
      input.id,
      ORG_ID,
      PROJECT_ID,
      "wallet_ramp_transitions_test",
      "source",
      "destination",
      "USDC",
      "10",
      input.type,
      input.type === "onramp" ? "inbound" : "outbound",
      input.status,
      isRamp ? "moonpay" : null,
      input.reference ?? null,
      isRamp ? "hosted" : null,
      isRamp ? "USD" : null,
      isRamp ? "10" : null,
      {},
      "2026-10-13T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z"
    )
    .run();
}

async function readStatus(id: string): Promise<PaymentTransferStatus | undefined> {
  const row = await getDb(env)
    .prepare("SELECT status FROM payment_transfers WHERE id = ?")
    .bind(id)
    .first<{ status: PaymentTransferStatus }>();
  return row?.status;
}

function transition(id: string, name: RampTransferTransitionId) {
  return createSystemPaymentsRepository(env).transitionRampTransfer({
    transferId: id,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    transition: name,
    updatedAt: "2026-10-13T01:00:00.000Z",
  });
}

describe("RAMP_TRANSFER_TRANSITIONS", () => {
  it("keeps each provider transition's source set, with no wallet-send status", () => {
    // Spelled out on purpose: a table edit that widens or narrows a provider
    // transition must fail here, not pass by comparing the table to itself.
    const observable: PaymentTransferStatus[] = [
      "awaiting_payment",
      "expired",
      "pending",
      "processing",
      "settling",
    ];
    expect(sortedSources("provider_awaiting_payment")).toEqual([
      "awaiting_payment",
      "expired",
      "pending",
    ]);
    expect(sortedSources("provider_settling")).toEqual(observable);
    expect(sortedSources("provider_settled")).toEqual(observable);
    expect(sortedSources("provider_failed")).toEqual(observable);
    expect(sortedSources("provider_expired")).toEqual(["awaiting_payment", "pending"]);
    expect(sortedSources("moonpay_attempt_failed")).toEqual([
      "awaiting_payment",
      "expired",
      "pending",
    ]);
    expect(sortedSources("moonpay_sell_failed")).toEqual([
      "awaiting_payment",
      "expired",
      "pending",
    ]);
    expect(sortedSources("moonpay_sell_failed_while_claimed")).toEqual(["processing"]);
  });

  it("lands each provider event on the status it names, for both ramp types", () => {
    expect(RAMP_TRANSFER_TRANSITIONS.provider_awaiting_payment.to).toBe("awaiting_payment");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_settling.to).toBe("settling");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_settled.to).toBe("settling");
    expect(RAMP_TRANSFER_TRANSITIONS.delivery_verified.to).toBe("completed");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_failed.to).toBe("failed");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_expired.to).toBe("expired");
    const providerTransitions = [
      "provider_awaiting_payment",
      "provider_settling",
      "provider_settled",
      "provider_failed",
      "provider_expired",
    ] as const;
    for (const name of providerTransitions) {
      expect(RAMP_TRANSFER_TRANSITIONS[name].types).toEqual(RAMP_TRANSFER_TYPES);
    }
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_attempt_failed.types).toEqual(["onramp"]);
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_attempt_failed.to).toBe("awaiting_payment");
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_sell_failed.types).toEqual(["offramp"]);
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_sell_failed.to).toBe("failed");
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_sell_failed_while_claimed.types).toEqual(["offramp"]);
    expect(RAMP_TRANSFER_TRANSITIONS.moonpay_sell_failed_while_claimed.to).toBe("processing");
  });

  it("keeps what SDP's own writers allowed before the table", () => {
    // Spelled out for the same reason as the provider source sets above.
    expect(sortedSources("canceled")).toEqual(["awaiting_payment", "pending"]);
    expect(sortedSources("quote_issued")).toEqual(["pending"]);
    expect(sortedSources("quote_failed")).toEqual(["pending"]);
    expect(sortedSources("offramp_deposit_claimed")).toEqual(["awaiting_payment"]);
    expect(sortedSources("offramp_deposit_confirmed")).toEqual(["processing"]);
    expect(sortedSources("offramp_deposit_failed")).toEqual(["processing"]);

    expect(RAMP_TRANSFER_TRANSITIONS.canceled.to).toBe("canceled");
    expect(RAMP_TRANSFER_TRANSITIONS.quote_issued.to).toBe("pending");
    expect(RAMP_TRANSFER_TRANSITIONS.quote_failed.to).toBe("failed");
    expect(RAMP_TRANSFER_TRANSITIONS.offramp_deposit_claimed.to).toBe("processing");
    expect(RAMP_TRANSFER_TRANSITIONS.offramp_deposit_confirmed.to).toBe("settling");
    expect(RAMP_TRANSFER_TRANSITIONS.offramp_deposit_failed.to).toBe("failed");

    for (const name of ["canceled", "quote_issued", "quote_failed"] as const) {
      expect(RAMP_TRANSFER_TRANSITIONS[name].types).toEqual(RAMP_TRANSFER_TYPES);
    }
    for (const name of [
      "offramp_deposit_claimed",
      "offramp_deposit_confirmed",
      "offramp_deposit_failed",
    ] as const) {
      expect(RAMP_TRANSFER_TRANSITIONS[name].types).toEqual(["offramp"]);
    }
  });

  it("releases a claimed deposit only back to awaiting it, for off-ramps alone", () => {
    expect(sortedSources("offramp_deposit_released")).toEqual(["processing"]);
    expect(RAMP_TRANSFER_TRANSITIONS.offramp_deposit_released.to).toBe("awaiting_payment");
    expect(RAMP_TRANSFER_TRANSITIONS.offramp_deposit_released.types).toEqual(["offramp"]);
  });

  it("never expires a settling transfer, so a stale expiry cannot undo a revival", () => {
    expect(RAMP_TRANSFER_TRANSITIONS.provider_expired.from).not.toContain("settling");
  });

  it("lets SDP abandon only a checkout still waiting on its customer", () => {
    expect(sortedSources("checkout_abandoned")).toEqual(["awaiting_payment", "pending"]);
    expect(RAMP_TRANSFER_TRANSITIONS.checkout_abandoned.to).toBe("expired");
    expect(RAMP_TRANSFER_TRANSITIONS.checkout_abandoned.types).toEqual(RAMP_TRANSFER_TYPES);
  });

  it("starts from no terminal status except expired", () => {
    const terminalSources = new Set(
      Object.values(RAMP_TRANSFER_TRANSITIONS)
        .flatMap((entry) => entry.from)
        .filter((status) => RAMP_TRANSFER_STATUS_TERMINAL[status])
    );
    expect([...terminalSources]).toEqual(["expired"]);
  });
});

describe("PaymentsRepository.transitionRampTransfer (postgres)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG_ID, "Ramp Transitions Test", "ramp-transitions-test", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "ramp-transitions@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a ramp transfer from a listed source status", async () => {
    await seedTransfer({ id: "xfr_legal", status: "awaiting_payment", type: "onramp" });

    const updated = await transition("xfr_legal", "provider_settling");

    expect(updated?.status).toBe("settling");
    expect(await readStatus("xfr_legal")).toBe("settling");
  });

  it("persists SDP's signed deposit when a provider settles during submission", async () => {
    await seedTransfer({ id: "xfr_submission_race", status: "processing", type: "offramp" });
    const repo = createSystemPaymentsRepository(env);
    await transition("xfr_submission_race", "provider_settled");

    const signed = await repo.persistSignedTransfer({
      transferId: "xfr_submission_race",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      signature: "submitted-signature",
      signedTransaction: "signed-by-sdp",
      lastValidBlockHeight: "100",
      updatedAt: "2026-10-13T01:00:01.000Z",
    });
    expect(signed?.status).toBe("settling");
    const started = await repo.markTransferSubmissionStarted({
      transferId: "xfr_submission_race",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      startedAt: "2026-10-13T01:00:02.000Z",
    });
    expect(started).toMatchObject({
      status: "settling",
      signature: "submitted-signature",
      signed_transaction: "signed-by-sdp",
      submission_started_at: "2026-10-13T01:00:02.000Z",
    });
  });

  it("matches nothing from an unlisted source status and leaves the row alone", async () => {
    await seedTransfer({ id: "xfr_illegal", status: "settling", type: "offramp" });

    expect(await transition("xfr_illegal", "provider_expired")).toBeNull();
    expect(await readStatus("xfr_illegal")).toBe("settling");
  });

  it("does not fail a MoonPay sale after its deposit was claimed", async () => {
    await seedTransfer({ id: "xfr_claimed_sale", status: "processing", type: "offramp" });

    expect(await transition("xfr_claimed_sale", "moonpay_sell_failed")).toBeNull();
    expect(await readStatus("xfr_claimed_sale")).toBe("processing");
    expect(
      (await transition("xfr_claimed_sale", "moonpay_sell_failed_while_claimed"))?.status
    ).toBe("processing");
  });

  it("releases an unsent claim only while the provider has not failed its sale", async () => {
    await seedTransfer({ id: "xfr_release_open", status: "processing", type: "offramp" });
    await seedTransfer({ id: "xfr_release_failed", status: "processing", type: "offramp" });
    await getDb(env)
      .prepare(
        `UPDATE payment_transfers
            SET provider_data = '{"providerFailure":{"reference":"moonpay-sale"}}'::jsonb
          WHERE id = ?`
      )
      .bind("xfr_release_failed")
      .run();
    const release = (id: string) =>
      createSystemPaymentsRepository(env).releaseOfframpDepositClaim({
        transferId: id,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        updatedAt: "2026-10-13T00:01:00.000Z",
      });

    expect((await release("xfr_release_open"))?.status).toBe("awaiting_payment");
    expect(await release("xfr_release_failed")).toBeNull();
    expect(await readStatus("xfr_release_failed")).toBe("processing");
  });

  it("never moves a wallet transfer, even from a listed source status", async () => {
    await seedTransfer({ id: "xfr_wallet", status: "pending", type: "transfer" });

    expect(await transition("xfr_wallet", "provider_failed")).toBeNull();
    expect(await readStatus("xfr_wallet")).toBe("pending");
  });

  it("never moves an on-ramp row through an off-ramp deposit transition", async () => {
    await seedTransfer({ id: "xfr_onramp_deposit", status: "processing", type: "onramp" });

    expect(await transition("xfr_onramp_deposit", "offramp_deposit_confirmed")).toBeNull();
    expect(await readStatus("xfr_onramp_deposit")).toBe("processing");
  });

  it("writes the fields a transition carries beside the status", async () => {
    const blockTime = "2026-10-19T00:00:00.000Z";
    await seedTransfer({ id: "xfr_deposit_landed", status: "processing", type: "offramp" });

    const updated = await createSystemPaymentsRepository(env).transitionRampTransfer({
      transferId: "xfr_deposit_landed",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      transition: "offramp_deposit_confirmed",
      signature: "deposit-signature",
      serializedTx: "deposit-serialized-tx",
      slot: 42,
      blockTime,
      fee: 5000,
      deliveryMode: "session_widget",
      error: null,
      updatedAt: "2026-10-19T00:00:01.000Z",
    });

    expect(updated?.status).toBe("settling");
    const row = await getDb(env)
      .prepare(
        `SELECT status, signature, serialized_tx, slot::text AS slot, fee::text AS fee,
                delivery_mode, block_time, error
         FROM payment_transfers WHERE id = ?`
      )
      .bind("xfr_deposit_landed")
      .first();
    expect(row).toEqual({
      status: "settling",
      signature: "deposit-signature",
      serialized_tx: "deposit-serialized-tx",
      slot: "42",
      fee: "5000",
      delivery_mode: "session_widget",
      block_time: blockTime,
      error: null,
    });
  });

  it("refuses a status change through updateTransfer on a ramp row only", async () => {
    await seedTransfer({ id: "xfr_ramp_direct", status: "pending", type: "offramp" });
    await seedTransfer({ id: "xfr_wallet_direct", status: "processing", type: "transfer" });
    const repository = createSystemPaymentsRepository(env);
    const tenant = { organizationId: ORG_ID, projectId: PROJECT_ID };
    const updatedAt = "2026-10-13T01:00:00.000Z";

    expect(
      await repository.updateTransfer({
        ...tenant,
        transferId: "xfr_ramp_direct",
        status: "failed",
        updatedAt,
      })
    ).toBeNull();
    expect(await readStatus("xfr_ramp_direct")).toBe("pending");

    const confirmed = await repository.updateTransfer({
      ...tenant,
      transferId: "xfr_wallet_direct",
      status: "confirmed",
      updatedAt,
    });
    expect(confirmed?.status).toBe("confirmed");
  });

  it("ignores an out-of-order settlement event and writes nothing", async () => {
    const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});
    await seedTransfer({
      id: "xfr_stale",
      status: "settling",
      type: "offramp",
      reference: "moonpay_stale",
    });

    const result = await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "moonpay_stale",
    });

    expect(result).toEqual({ applied: false, outcome: "ignored" });
    expect(await readStatus("xfr_stale")).toBe("settling");
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_ramp_settlement_ignored",
        transfer_id: "xfr_stale",
        transition: "provider_awaiting_payment",
        from_status: "settling",
        to_status: "awaiting_payment",
      })
    );
  });
});

/** A ramp status writer. Every one names its `RAMP_TRANSFER_TRANSITIONS` entry. */
interface RampStatusWriter {
  writer: string;
  file: string;
  /** A string that must appear in `file`, so a moved or deleted writer fails this test. */
  evidence: string;
  /** Its `transitionRampTransfer` calls, so a new one in a listed file still fails. */
  guardedCalls: number;
}

const RAMP_STATUS_WRITERS: RampStatusWriter[] = [
  {
    writer: "provider settlement events (webhooks and replay)",
    file: "apps/sdp-api/src/services/payments/ramp-settlements.ts",
    evidence: ".transitionRampTransfer(update)",
    guardedCalls: 1,
  },
  {
    writer: "ramp chain delivery verifier",
    file: "apps/sdp-api/src/services/jobs/verify-ramp-deliveries.ts",
    evidence: 'transition: "delivery_verified"',
    guardedCalls: 2,
  },
  {
    writer: "abandoned checkout expiry (provider status sweep)",
    file: "apps/sdp-api/src/services/jobs/sweep-ramp-transfer-statuses.ts",
    evidence: 'transition: "checkout_abandoned"',
    guardedCalls: 1,
  },
  {
    writer: "MoonPay failed buy attempt",
    file: "apps/sdp-api/src/services/ramps/webhooks/moonpay.ts",
    evidence: 'transition: "moonpay_attempt_failed"',
    guardedCalls: 1,
  },
  {
    writer: "MoonPay sale failure held on a claimed deposit",
    file: "apps/sdp-api/src/services/ramps/webhooks/moonpay.ts",
    evidence: 'transition: "moonpay_sell_failed_while_claimed"',
    guardedCalls: 1,
  },
  {
    writer: "cancel",
    file: "apps/sdp-api/src/routes/payments/ramps/handlers.ts",
    evidence: 'transition: "canceled"',
    guardedCalls: 1,
  },
  {
    writer: "MoonPay on-ramp quote fill and failure",
    file: "apps/sdp-api/src/routes/payments/ramps/onramp/handlers.ts",
    evidence: 'transition: "quote_failed"',
    guardedCalls: 2,
  },
  {
    writer: "MoonPay off-ramp quote fill and failure",
    file: "apps/sdp-api/src/routes/payments/ramps/offramp/handlers.ts",
    evidence: 'transition: "quote_failed"',
    guardedCalls: 2,
  },
  {
    // Repository-internal: its deposit-instruction preconditions ride the same
    // compare-and-set, so it never calls the public method.
    writer: "off-ramp deposit claim",
    file: "apps/sdp-api/src/db/repositories/payments.repository.postgres.ts",
    evidence: 'transition: "offramp_deposit_claimed"',
    guardedCalls: 0,
  },
  {
    writer: "off-ramp deposit outcome",
    file: "apps/sdp-api/src/routes/payments/transfers/handlers.ts",
    evidence: "transition: OFFRAMP_DEPOSIT_OUTCOME_TRANSITIONS[patch.status]",
    guardedCalls: 1,
  },
  {
    // Repository-internal like the claim: its no-signed-bytes preconditions
    // ride the same compare-and-set.
    writer: "unsent off-ramp deposit release",
    file: "apps/sdp-api/src/db/repositories/payments.repository.postgres.ts",
    evidence: 'transition: "offramp_deposit_released"',
    guardedCalls: 0,
  },
];

const GUARDED_STATUS_WRITE = /\.transitionRampTransfer\(/g;

function apiSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return apiSourceFiles(entryPath);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

describe("ramp transfer status writers", () => {
  it("finds every listed writer where the list says it is", () => {
    for (const writer of RAMP_STATUS_WRITERS) {
      const source = readFileSync(path.join(repositoryRoot, writer.file), "utf8");
      expect(source, `${writer.writer} (${writer.file})`).toContain(writer.evidence);
    }
  });

  it("accounts for every guarded ramp status write, call by call", () => {
    const expected: Record<string, number> = {};
    for (const writer of RAMP_STATUS_WRITERS) {
      if (writer.guardedCalls > 0) {
        expected[writer.file] = (expected[writer.file] ?? 0) + writer.guardedCalls;
      }
    }
    const actual: Record<string, number> = {};
    for (const file of apiSourceFiles(path.join(repositoryRoot, "apps/sdp-api/src"))) {
      const calls = readFileSync(file, "utf8").match(GUARDED_STATUS_WRITE)?.length ?? 0;
      if (calls > 0) {
        actual[path.relative(repositoryRoot, file)] = calls;
      }
    }

    expect(actual).toEqual(expected);
  });
});
