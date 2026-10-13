import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type PaymentTransferStatus,
  type PaymentTransferType,
  RAMP_TRANSFER_STATUS_TERMINAL,
  RAMP_TRANSFER_TRANSITIONS,
  RAMP_TRANSFER_TYPES,
  type RampTransferTransitionId,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createSystemPaymentsRepository } from "@/db/repositories";
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
  it("keeps the source sets the settlement core enforced before the table", () => {
    // Spelled out on purpose: a table edit that widens or narrows a provider
    // transition must fail here, not pass by comparing the table to itself.
    const observable: PaymentTransferStatus[] = [
      "awaiting_payment",
      "confirmed",
      "expired",
      "finalized",
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
  });

  it("lands each provider event on the status it names, for both ramp types", () => {
    expect(RAMP_TRANSFER_TRANSITIONS.provider_awaiting_payment.to).toBe("awaiting_payment");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_settling.to).toBe("settling");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_settled.to).toBe("completed");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_failed.to).toBe("failed");
    expect(RAMP_TRANSFER_TRANSITIONS.provider_expired.to).toBe("expired");
    for (const entry of Object.values(RAMP_TRANSFER_TRANSITIONS)) {
      expect(entry.types).toEqual(RAMP_TRANSFER_TYPES);
    }
  });

  it("never expires a settling transfer, so a stale expiry cannot undo a revival", () => {
    expect(RAMP_TRANSFER_TRANSITIONS.provider_expired.from).not.toContain("settling");
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

  it("matches nothing from an unlisted source status and leaves the row alone", async () => {
    await seedTransfer({ id: "xfr_illegal", status: "settling", type: "offramp" });

    expect(await transition("xfr_illegal", "provider_expired")).toBeNull();
    expect(await readStatus("xfr_illegal")).toBe("settling");
  });

  it("never moves a wallet transfer, even from a listed source status", async () => {
    await seedTransfer({ id: "xfr_wallet", status: "pending", type: "transfer" });

    expect(await transition("xfr_wallet", "provider_failed")).toBeNull();
    expect(await readStatus("xfr_wallet")).toBe("pending");
  });

  it("logs a settlement event the table refuses and writes nothing", async () => {
    const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});
    await seedTransfer({
      id: "xfr_refused",
      status: "settling",
      type: "offramp",
      reference: "moonpay_refused",
    });

    const result = await applyRampSettlementEvent(env, {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "moonpay_refused",
    });

    expect(result).toEqual({ applied: false });
    expect(await readStatus("xfr_refused")).toBe("settling");
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_ramp_settlement_refused",
        transfer_id: "xfr_refused",
        transition: "provider_awaiting_payment",
        from_status: "settling",
        to_status: "awaiting_payment",
      })
    );
  });
});

type RampStatusWriterRoute =
  /** Writes go through `transitionRampTransfer`. */
  | "table"
  /** Still sets the status itself; moves onto the table in HOO-2087. */
  | "direct"
  /** Still sets the status itself; deleted with BVNK (HOO-2037). */
  | "direct_until_bvnk_removal";

interface RampStatusWriter {
  writer: string;
  file: string;
  /** A string that must appear in `file`, so a moved or deleted writer fails this test. */
  evidence: string;
  route: RampStatusWriterRoute;
  /** Its `transitionRampTransfer` or `updateTransferStatusGuarded` calls, so a new one in a listed file still fails. */
  guardedCalls: number;
}

const RAMP_STATUS_WRITERS: RampStatusWriter[] = [
  {
    writer: "provider settlement events (webhooks and replay)",
    file: "apps/sdp-api/src/services/payments/ramp-settlements.ts",
    evidence: ".transitionRampTransfer(update)",
    route: "table",
    guardedCalls: 1,
  },
  {
    writer: "cancel",
    file: "apps/sdp-api/src/routes/payments/ramps/handlers.ts",
    evidence: 'toStatus: "canceled"',
    route: "direct",
    guardedCalls: 1,
  },
  {
    writer: "MoonPay on-ramp quote fill and failure",
    file: "apps/sdp-api/src/routes/payments/ramps/onramp/handlers.ts",
    evidence: "status: rampQuoteTransferStatus(quote)",
    route: "direct",
    guardedCalls: 0,
  },
  {
    writer: "MoonPay off-ramp quote fill and failure",
    file: "apps/sdp-api/src/routes/payments/ramps/offramp/handlers.ts",
    evidence: "status: rampQuoteTransferStatus(quote)",
    route: "direct",
    guardedCalls: 0,
  },
  {
    writer: "off-ramp deposit claim",
    file: "apps/sdp-api/src/db/repositories/payments.repository.postgres.ts",
    evidence: "async updateOnchainTransferForRamp(",
    route: "direct",
    guardedCalls: 0,
  },
  {
    writer: "off-ramp deposit outcome",
    file: "apps/sdp-api/src/routes/payments/transfers/handlers.ts",
    evidence: 'status: reusedRampTransfer ? "settling" : "confirmed"',
    route: "direct",
    guardedCalls: 0,
  },
  {
    writer: "BVNK off-ramp quote failure",
    file: "apps/sdp-api/src/routes/payments/ramps/offramp/handlers.ts",
    evidence: 'fromStatuses: ["pending"]',
    route: "direct_until_bvnk_removal",
    guardedCalls: 1,
  },
  {
    writer: "BVNK quote and pay-in route helpers",
    file: "apps/sdp-api/src/routes/payments/ramps/providers/bvnk.ts",
    evidence: ".updateTransferStatusGuarded(",
    route: "direct_until_bvnk_removal",
    guardedCalls: 2,
  },
  {
    writer: "BVNK pay-in and payout reconciliation",
    file: "apps/sdp-api/src/db/repositories/bvnk-onramp-transfers.repository.postgres.ts",
    evidence: "SET status = 'settling'",
    route: "direct_until_bvnk_removal",
    guardedCalls: 0,
  },
];

const GUARDED_STATUS_WRITE = /\.(transitionRampTransfer|updateTransferStatusGuarded)\(/g;

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

  it("keeps table writers off the caller-supplied guard", () => {
    for (const writer of RAMP_STATUS_WRITERS.filter((entry) => entry.route === "table")) {
      const source = readFileSync(path.join(repositoryRoot, writer.file), "utf8");
      expect(source, writer.file).not.toContain(".updateTransferStatusGuarded(");
    }
  });
});
