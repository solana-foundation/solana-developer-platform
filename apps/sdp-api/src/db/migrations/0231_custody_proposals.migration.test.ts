import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import {
  CUSTODY_PROPOSAL_ACTIVE_PHASES,
  CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
  CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT,
  CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES,
  CUSTODY_PROPOSAL_PROVIDER_PHASES,
  CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE,
  type CustodyProposalAuthorizationState,
  type CustodyProposalProviderPhase,
} from "@sdp/types/custody-proposals";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationSql = readFileSync(path.join(directory, "0231_custody_proposals.sql"), "utf8");
const validateSql = readFileSync(
  path.join(directory, "0232_custody_proposals_validate.sql"),
  "utf8"
);
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(
    "CREATE TEMP TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, UNIQUE(id, organization_id)) ON COMMIT DROP"
  );
  await client.query("CREATE TEMP TABLE custody_wallets (id TEXT PRIMARY KEY) ON COMMIT DROP");
  await client.query(
    "CREATE TEMP TABLE payment_transfers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(id, organization_id, project_id)) ON COMMIT DROP"
  );
  await client.query(
    "INSERT INTO projects VALUES ('project', 'org'), ('other_project', 'other_org')"
  );
  await client.query(
    "INSERT INTO payment_transfers VALUES ('payment', 'org', 'project', 'processing')"
  );
  await client.query(
    migrationSql.replace("CREATE TABLE custody_proposals", "CREATE TEMP TABLE custody_proposals")
  );
  await client.query(validateSql);
});
afterEach(async () => {
  await client.query("ROLLBACK");
});

interface ProposalOverrides {
  payment?: string;
  organization?: string;
  project?: string;
  phase?: string;
  authorization?: string;
  refusedAt?: string | null;
  cancelAttempt?: number;
  cancelRequestedAt?: string | null;
  cancelDeclinedAt?: string | null;
  cancelAcknowledgedAt?: string | null;
  alertedAt?: string | null;
  providerTransactionId?: string | null;
  firstMissingAt?: string | null;
}

const NOW = "2026-11-11T00:00:00.000Z";

async function insertProposal(overrides: ProposalOverrides = {}): Promise<void> {
  const refusedAt = overrides.refusedAt ?? null;
  await client.query(
    `INSERT INTO custody_proposals
       (id, organization_id, project_id, payment_transfer_id, provider, binding,
        provider_phase, authorization_state, refused_at, refusal_reason, refusal_message,
        cancel_attempt, cancel_requested_at, cancel_declined_at, cancel_acknowledged_at,
        alerted_at, provider_transaction_id, first_missing_at, next_check_at, created_at, updated_at)
     VALUES ('proposal', $1, $2, $16, 'fireblocks', '{}', $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14, $15, $15, $15)`,
    [
      overrides.organization ?? "org",
      overrides.project ?? "project",
      overrides.phase ?? "unsent",
      overrides.authorization ?? "authorized",
      refusedAt,
      refusedAt === null ? null : "principal_revoked",
      refusedAt === null ? null : "The key was revoked",
      overrides.cancelAttempt ?? 0,
      overrides.cancelRequestedAt ?? null,
      overrides.cancelDeclinedAt ?? null,
      overrides.cancelAcknowledgedAt ?? null,
      overrides.alertedAt ?? null,
      overrides.providerTransactionId ?? null,
      overrides.firstMissingAt ?? null,
      NOW,
      overrides.payment ?? "payment",
    ]
  );
}

function productOverrides(
  phase: CustodyProposalProviderPhase,
  authorization: CustodyProposalAuthorizationState
): ProposalOverrides {
  const overrides: ProposalOverrides = { phase, authorization };
  if (CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[phase].identity === "required")
    overrides.providerTransactionId = "provider-transaction";
  if (phase === "absent") overrides.firstMissingAt = NOW;
  if (authorization !== "authorized") overrides.refusedAt = NOW;
  switch (authorization) {
    case "authorized":
    case "refused":
    case "committed_after_refusal":
      break;
    case "cancel_requested":
    case "cancel_ambiguous":
      overrides.cancelAttempt = 1;
      overrides.cancelRequestedAt = NOW;
      break;
    case "cancel_declined":
    case "cancel_retry_requested":
    case "cancel_retry_ambiguous":
      overrides.cancelAttempt = 2;
      overrides.cancelRequestedAt = NOW;
      overrides.cancelDeclinedAt = NOW;
      break;
    case "cancel_acknowledged":
      overrides.cancelAttempt = 1;
      overrides.cancelRequestedAt = NOW;
      overrides.cancelAcknowledgedAt = NOW;
      break;
    case "refusal_alerted":
      overrides.alertedAt = NOW;
      break;
    default: {
      const exhaustive: never = authorization;
      throw new Error(`Unexpected authorization state: ${String(exhaustive)}`);
    }
  }
  return overrides;
}

async function expectRejectedWith(
  operation: () => Promise<void>,
  error: { code: string; constraint?: string }
): Promise<void> {
  await client.query("SAVEPOINT rejected_write");
  try {
    await expect(operation()).rejects.toMatchObject(error);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_write");
  }
}

async function expectRejected(operation: () => Promise<void>, code: string): Promise<void> {
  await expectRejectedWith(operation, { code });
}

describe("0231 custody proposals", () => {
  it("keeps previous payment writers compatible without adding queue columns", async () => {
    await client.query(
      "INSERT INTO payment_transfers VALUES ('old_writer', 'org', 'project', 'processing')"
    );
    await client.query("UPDATE payment_transfers SET status = 'confirmed' WHERE id = 'old_writer'");
    expect(
      (await client.query("SELECT * FROM payment_transfers WHERE id = 'old_writer'")).rows
    ).toEqual([
      { id: "old_writer", organization_id: "org", project_id: "project", status: "confirmed" },
    ]);
  });

  it("enforces exact payment and project tenant parents", async () => {
    await client.query(
      "INSERT INTO payment_transfers VALUES ('cross_tenant_payment', 'org', 'other_project', 'processing')"
    );
    await expectRejectedWith(
      () => insertProposal({ organization: "other_org", project: "other_project" }),
      { code: "23503", constraint: "custody_proposals_payment_fk" }
    );
    await expectRejectedWith(
      () => insertProposal({ payment: "cross_tenant_payment", project: "other_project" }),
      { code: "23503", constraint: "custody_proposals_project_fk" }
    );
    await insertProposal();
    expect((await client.query("SELECT payment_transfer_id FROM custody_proposals")).rows).toEqual([
      { payment_transfer_id: "payment" },
    ]);
  });

  it("rejects invalid state combinations before a worker can read them", async () => {
    await expectRejected(() => insertProposal({ phase: "not_a_phase" }), "23514");
    await expectRejected(() => insertProposal({ authorization: "refused" }), "23514");
    await expectRejected(
      () => insertProposal({ cancelDeclinedAt: "2026-11-11T00:00:00.000Z" }),
      "23514"
    );
    await expectRejected(
      () => insertProposal({ cancelAcknowledgedAt: "2026-11-11T00:00:00.000Z" }),
      "23514"
    );
    await expectRejected(() => insertProposal({ phase: "completed" }), "23514");
  });

  it("pins canonical phase/provider sets and indexes completed alerts independently", async () => {
    const constraints = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'pg_temp.custody_proposals'::regclass AND contype = 'c'"
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    for (const value of [
      ...CUSTODY_PROVIDERS,
      ...CUSTODY_PROPOSAL_PROVIDER_PHASES,
      ...CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
    ])
      expect(definitions).toContain(`'${value}'::text`);
    const indexes = await client.query<{ indexname: string; definition: string }>(
      "SELECT c.relname AS indexname, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'pg_temp.custody_proposals'::regclass"
    );
    const due = required(
      indexes.rows.find((row) => row.indexname === "custody_proposals_due_idx")
    ).definition;
    for (const phase of CUSTODY_PROPOSAL_ACTIVE_PHASES) expect(due).toContain(`'${phase}'::text`);
    const legacy = indexes.rows.find(
      (row) => row.indexname === "custody_proposals_legacy_unsent_idx"
    )?.definition;
    expect(legacy).toContain("(payment_transfer_id)");
    expect(legacy).toContain("'unsent'::text");
    expect(legacy).toContain("'authorized'::text");
    const alerts = required(
      indexes.rows.find((row) => row.indexname === "custody_proposals_unalerted_idx")
    ).definition;
    expect(alerts).toContain("'committed_after_refusal'::text");
    expect(alerts).not.toContain("alerted_at");
    expect(alerts).not.toContain("provider_phase");
  });
  it("enforces every canonical provider/authorization product in PostgreSQL", async () => {
    for (const phase of CUSTODY_PROPOSAL_PROVIDER_PHASES) {
      const valid: readonly CustodyProposalAuthorizationState[] =
        CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE[phase];
      for (const authorization of CUSTODY_PROPOSAL_AUTHORIZATION_STATES) {
        const input = productOverrides(phase, authorization);
        if (valid.includes(authorization)) {
          await insertProposal(input);
          await client.query("DELETE FROM custody_proposals WHERE id = 'proposal'");
        } else {
          await expectRejected(() => insertProposal(input), "23514");
        }
      }
    }
  });

  it("rejects inconsistent attempt, decline, acknowledgment and alert progress", async () => {
    const requested = productOverrides("pending", "cancel_requested");
    await expectRejected(() => insertProposal({ ...requested, cancelAttempt: 0 }), "23514");
    await expectRejected(() => insertProposal({ ...requested, cancelRequestedAt: null }), "23514");
    await expectRejected(() => insertProposal({ ...requested, cancelDeclinedAt: NOW }), "23514");
    await expectRejected(
      () =>
        insertProposal({
          ...productOverrides("pending", "cancel_retry_requested"),
          cancelDeclinedAt: null,
        }),
      "23514"
    );
    await expectRejected(
      () =>
        insertProposal({
          ...productOverrides("pending", "cancel_acknowledged"),
          cancelAcknowledgedAt: null,
        }),
      "23514"
    );
    await expectRejected(
      () =>
        insertProposal({ ...productOverrides("completed", "refusal_alerted"), alertedAt: null }),
      "23514"
    );
    await expectRejected(
      () =>
        insertProposal({
          ...productOverrides("completed", "committed_after_refusal"),
          alertedAt: NOW,
        }),
      "23514"
    );
    await expectRejected(
      () => insertProposal({ ...requested, providerTransactionId: null }),
      "23514"
    );
    await expectRejected(
      () =>
        insertProposal({
          ...productOverrides("unsent", "refused"),
          providerTransactionId: "unexpected",
        }),
      "23514"
    );
  });

  it("requires the first missing observation before accepting absent progress", async () => {
    const absent = productOverrides("absent", "authorized");
    await expectRejected(() => insertProposal({ ...absent, firstMissingAt: null }), "23514");
    await insertProposal(absent);
    expect(
      (await client.query("SELECT provider_phase, first_missing_at FROM custody_proposals")).rows
    ).toEqual([{ provider_phase: "absent", first_missing_at: NOW }]);
  });

  it("bounds attempt identities while retaining authorized legacy acknowledgment evidence", async () => {
    const requested = productOverrides("pending", "cancel_requested");
    await expectRejected(() => insertProposal({ ...requested, cancelAttempt: -1 }), "23514");
    await expectRejected(
      () =>
        insertProposal({ ...requested, cancelAttempt: CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT + 1 }),
      "22003"
    );
    await insertProposal({ ...requested, cancelAttempt: CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT });
    await client.query("DELETE FROM custody_proposals WHERE id = 'proposal'");
    await insertProposal({
      ...productOverrides("pending", "authorized"),
      cancelAttempt: 1,
      cancelRequestedAt: NOW,
      cancelAcknowledgedAt: NOW,
    });
    expect(
      (
        await client.query(
          "SELECT authorization_state, refused_at, cancel_acknowledged_at FROM custody_proposals"
        )
      ).rows
    ).toEqual([
      {
        authorization_state: "authorized",
        refused_at: null,
        cancel_acknowledged_at: NOW,
      },
    ]);
  });
});
