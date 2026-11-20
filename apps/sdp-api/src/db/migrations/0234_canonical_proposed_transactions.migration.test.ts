import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { canonicalProposalMigrationFixture, sql } from "@/test/helpers/proposal-migrations";

const { client, schema, setup, teardown, legacyProposal, migrate, canonical, refuse } =
  canonicalProposalMigrationFixture();
const backfillSql = sql("0235_canonical_signing_proposal_backfill.sql");
const NOW = "2026-11-20T15:00:00.000Z";
beforeAll(() => client.connect());
afterAll(() => client.end());
beforeEach(setup);
afterEach(teardown);

describe("canonical proposed transaction migration", () => {
  it("retains transfer writers while accepting non-transfer proposals without a payment", async () => {
    await migrate();
    await client.query(
      `INSERT INTO custody_proposals
       (id, organization_id, project_id, payment_transfer_id, provider, binding,
        provider_phase, authorization_state, next_check_at, created_at, updated_at)
       VALUES ('transfer', 'org', 'project', 'payment', 'fireblocks', '{}', 'unsent',
         'authorized', $1, $1, $1)`,
      [NOW]
    );
    expect(await canonical("transfer")).toMatchObject({
      kind: "transfer",
      operation: "TRANSFER",
      payment_transfer_id: "payment",
    });
    await legacyProposal();
    expect(await canonical()).toMatchObject({
      id: "fbp_original",
      kind: "signing",
      operation: "PROGRAM_CALL",
      payment_transfer_id: null,
      provider_phase: "pending",
      request_id: "request",
      binding: {
        connectionId: "connection",
        accountFingerprint: "fingerprint",
        vaultAccountId: "0",
        sourceAddress: "source",
        assetId: "SOL_TEST",
      },
    });
  });

  it("migrates every historical state with the original external identity", async () => {
    const states = [
      ["SUBMITTING", "submitting"],
      ["PENDING_AUTHORIZATION", "pending"],
      ["PENDING_STATUS_UPDATE", "executing"],
      ["SIGNED", "completed"],
      ["COMPLETED", "completed"],
      ["FAILED", "failed"],
      ["CANCELED", "cancelled"],
    ] as const;
    for (const [status] of states) await legacyProposal(`fbp_${status}`, status);
    await migrate();
    for (const [status, phase] of states)
      expect(await canonical(`fbp_${status}`)).toMatchObject({
        id: `fbp_${status}`,
        provider_phase: phase,
        provider_status: status === "SUBMITTING" ? null : status,
        created_at: NOW,
      });
    await client.query(backfillSql);
    expect(
      (await client.query("SELECT COUNT(*)::int AS count FROM custody_proposals")).rows
    ).toEqual([{ count: states.length }]);
  });

  it("preserves cancellation before acceptance and never clears its refusal", async () => {
    await legacyProposal("fbp_original", "SUBMITTING", NOW);
    await migrate();
    expect(await canonical()).toMatchObject({
      provider_phase: "submitting",
      authorization_state: "refused",
      refused_at: NOW,
      cancel_attempt: 0,
      cancel_requested_at: null,
    });
    await client.query(
      "UPDATE fireblocks_signing_proposals SET provider_transaction_id = 'accepted', status = 'PENDING_AUTHORIZATION' WHERE id = 'fbp_original'"
    );
    expect(await canonical()).toMatchObject({
      provider_phase: "pending",
      authorization_state: "refused",
      refused_at: NOW,
    });
  });

  it("makes prior-image signature observations return a canonical cancellation", async () => {
    await legacyProposal();
    await migrate();
    await refuse();
    const result = await client.query(
      `UPDATE fireblocks_signing_proposals SET status = 'SIGNED', finished_at = $1
        WHERE id = 'fbp_original' RETURNING cancel_requested_at`,
      [NOW]
    );
    expect(result.rows).toEqual([{ cancel_requested_at: NOW }]);
    expect(await canonical()).toMatchObject({
      provider_phase: "completed",
      authorization_state: "committed_after_refusal",
      refused_at: NOW,
      version: 2,
    });
  });

  it("serializes an in-flight canonical cancellation before returning a legacy signature", async () => {
    await legacyProposal();
    await migrate();
    const cancellation = new Client({ connectionString: adminDatabaseUrl });
    const observation = new Client({ connectionString: adminDatabaseUrl });
    await Promise.all([cancellation.connect(), observation.connect()]);
    try {
      await Promise.all([
        cancellation.query(`SET search_path TO ${schema}, public`),
        observation.query(`SET search_path TO ${schema}, public`),
      ]);
      await cancellation.query("BEGIN");
      await cancellation.query(
        `UPDATE custody_proposals SET authorization_state = 'refused', refused_at = $1,
         refusal_reason = 'cancellation_requested', refusal_message = 'Cancellation requested',
         version = version + 1 WHERE id = 'fbp_original'`,
        [NOW]
      );
      const observed = observation.query(
        "UPDATE fireblocks_signing_proposals SET status = 'SIGNED' WHERE id = 'fbp_original' RETURNING cancel_requested_at"
      );
      await cancellation.query("COMMIT");
      expect((await observed).rows).toEqual([{ cancel_requested_at: NOW }]);
      expect(await canonical()).toMatchObject({
        provider_phase: "completed",
        authorization_state: "committed_after_refusal",
      });
    } finally {
      await cancellation.query("ROLLBACK");
      await Promise.all([cancellation.end(), observation.end()]);
    }
  });

  it("does not regress canonical terminal progress or cancellation attempts", async () => {
    await legacyProposal();
    await migrate();
    await client.query(
      `UPDATE custody_proposals SET provider_phase = 'completed', authorization_state = 'committed_after_refusal',
       refused_at = $1, refusal_reason = 'cancellation_requested', refusal_message = 'Cancellation requested',
       cancel_attempt = 2, cancel_requested_at = $1, cancel_declined_at = $1,
       provider_status = 'SIGNED', finished_at = $1, version = 7 WHERE id = 'fbp_original'`,
      [NOW]
    );
    await client.query(
      "UPDATE fireblocks_signing_proposals SET status = 'PENDING_SIGNATURE' WHERE id = 'fbp_original'"
    );
    expect(await canonical()).toMatchObject({
      provider_phase: "completed",
      provider_status: "SIGNED",
      authorization_state: "committed_after_refusal",
      cancel_attempt: 2,
      cancel_declined_at: NOW,
      finished_at: NOW,
      version: 8,
    });
  });

  it("refuses a late old-image cancellation after canonical signature acceptance", async () => {
    await legacyProposal();
    await migrate();
    await client.query(
      "UPDATE custody_proposals SET provider_phase = 'completed', provider_status = 'SIGNED', finished_at = $1 WHERE id = 'fbp_original'",
      [NOW]
    );
    const result = await client.query(
      "UPDATE fireblocks_signing_proposals SET cancel_requested_at = $1 WHERE id = 'fbp_original' RETURNING id",
      [NOW]
    );
    expect(result.rows).toEqual([]);
    expect(await canonical()).toMatchObject({
      provider_phase: "completed",
      authorization_state: "authorized",
      refused_at: null,
    });
  });

  it("rolls the legacy observation back when its immutable binding changes", async () => {
    await legacyProposal();
    await migrate();
    await expect(
      client.query(
        "UPDATE fireblocks_signing_proposals SET account_fingerprint = 'different' WHERE id = 'fbp_original'"
      )
    ).rejects.toMatchObject({ code: "23514" });
    expect(await canonical()).toMatchObject({ version: 0 });
    expect(
      (await client.query("SELECT account_fingerprint FROM fireblocks_signing_proposals")).rows
    ).toEqual([{ account_fingerprint: "fingerprint" }]);
  });
});
