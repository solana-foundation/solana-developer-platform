import {
  type CustodyProposalEvent,
  hasUnalertedCustodyProposalRefusal,
} from "@sdp/types/custody-proposals";
import { SUCCESSFUL_PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { getDb } from "@/db/client";
import type { CustodyProposalRow } from "@/db/repositories/custody-proposals.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createSystemAuditService, criticalOutcomeEntry } from "@/services/audit.service";
import { systemProposalLedger } from "@/services/jobs/proposal-recovery-ledger";
import { env } from "@/test/helpers/env";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { ProposalLedger } from "./custody-proposal-ledger";
import { applyProposalEvent } from "./custody-proposal-ledger";
import { ensureTransferProposal, reconcileRecordedProposalOutcome } from "./fireblocks-transfer";

const ORGANIZATION = { id: "org_proposal_ledger", slug: "proposal-ledger" };
const MEMBER = organizationMember("proposal_ledger", "admin");
const TRANSFER_ID = "xfr_proposal_ledger";
const NOW = "2026-11-12T10:00:00.000Z";
const LATER = "2026-11-12T10:01:00.000Z";
const LAST = "2026-11-12T10:02:00.000Z";
const SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const BINDING = {
  connectionId: "ledger-connection",
  accountFingerprint: "ledger-account",
  vaultAccountId: "0",
  assetId: "SOL_TEST",
};
const REFUSAL = {
  type: "admission_refused",
  at: NOW,
  reason: "principal_not_live",
  message: "The initiating principal is no longer active",
} as const satisfies CustodyProposalEvent;
const COMPLETED = {
  type: "observed",
  at: LATER,
  phase: "completed",
  providerTransactionId: "provider-transaction",
  providerStatus: "COMPLETED",
  providerSubStatus: null,
} as const satisfies CustodyProposalEvent;
let projectId: string;
let auditIntentId: string;
let ledger: ProposalLedger;

function identity() {
  return { transferId: TRANSFER_ID, organizationId: ORGANIZATION.id, projectId };
}

async function transfer(): Promise<PaymentTransferRow> {
  const row = await ledger.repo.getTransferById(identity());
  if (row === null) throw new Error("Missing custody proposal test transfer");
  return row;
}

async function proposal(): Promise<CustodyProposalRow> {
  const row = await ledger.proposals.getForTransfer(identity());
  if (row === null) throw new Error("Missing custody proposal test proposal");
  return row;
}

async function apply(event: CustodyProposalEvent) {
  return applyProposalEvent(ledger, await transfer(), await proposal(), event);
}

async function auditEvents() {
  return getDb(env).queryMany<{
    organization_id: string;
    user_id: string | null;
    api_key_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT organization_id, user_id, api_key_id, action, resource_type,
            resource_id, metadata::jsonb AS metadata
       FROM audit_logs
      WHERE resource_id = ? AND action = 'update'
      ORDER BY ledger_sequence`,
    [TRANSFER_ID]
  );
}

async function outcomes() {
  return getDb(env).queryMany<{ status: string; metadata: Record<string, unknown> }>(
    `SELECT status, metadata::jsonb AS metadata FROM audit_logs
      WHERE resource_id = ? AND metadata::jsonb ->> 'auditPhase' = 'outcome'
      ORDER BY ledger_sequence`,
    [TRANSFER_ID]
  );
}

/** Fail the actual audit INSERT after proposal and payment writes have executed. */
async function refuseAudit(): Promise<() => Promise<void>> {
  const db = getDb(env);
  await db.execute(`CREATE FUNCTION test_refuse_custody_proposal_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.metadata::jsonb ->> 'eventType' LIKE 'proposal_%'
         OR NEW.metadata::jsonb ->> 'auditPhase' = 'outcome' THEN
        RAISE EXCEPTION 'custody proposal audit refused';
      END IF;
      RETURN NEW;
    END $$`);
  await db.execute(`CREATE TRIGGER test_refuse_custody_proposal_audit BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION test_refuse_custody_proposal_audit()`);
  const restore = async () => {
    await db.execute("DROP TRIGGER IF EXISTS test_refuse_custody_proposal_audit ON audit_logs");
    await db.execute("DROP FUNCTION IF EXISTS test_refuse_custody_proposal_audit()");
  };
  onTestFinished(restore);
  return restore;
}

async function seedTransfer(transferId: string, intentId: string | null) {
  await getDb(env).execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address,
        destination_address, token, amount, type, direction, status,
        created_at, updated_at, provider_reference, provider_data, audit_intent_id)
     VALUES (?, ?, ?, 'provider-wallet', 'Source', 'Destination', 'SOL', '1',
             'transfer', 'outbound', 'processing', ?, ?, 'provider-transaction',
             ?::jsonb, ?)`,
    [
      transferId,
      ORGANIZATION.id,
      projectId,
      NOW,
      NOW,
      JSON.stringify({
        fireblocksTransfer: BINDING,
        fireblocksStatus: "PENDING_AUTHORIZATION",
        retainedEvidence: true,
      }),
      intentId,
    ]
  );
}

/** Models an older deployed image: terminal payment/audit writes, no proposal version change. */
async function recordOlderRevisionCompletion(
  status: (typeof SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)[number]
) {
  await ledger.audited(async (repo) => {
    const updated = await repo.updateTransfer({
      ...identity(),
      expectedStatus: "processing",
      status,
      signature: SIGNATURE,
      providerData: { fireblocksStatus: "COMPLETED", fireblocksSubStatus: null },
      error: null,
      updatedAt: LATER,
    });
    if (updated === null) throw new Error("Older revision could not settle the test payment");
    const closed = await repo.closeTransferAuditIntent({ ...identity(), auditIntentId });
    if (!closed) throw new Error("Older revision could not close the test audit intent");
    return {
      entry: criticalOutcomeEntry(
        {
          id: auditIntentId,
          entry: {
            organizationId: ORGANIZATION.id,
            action: "transfer",
            resourceType: "payment_transfer",
            resourceId: TRANSFER_ID,
          },
        },
        { status: "success", metadata: { fireblocksStatus: "COMPLETED", signature: SIGNATURE } }
      ),
      result: updated,
    };
  });
}

describe("custody proposal event ledger", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [MEMBER] });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: MEMBER.userId,
      members: [MEMBER.userId],
    });
    projectId = projects.sandbox.id;
    ledger = systemProposalLedger(env);
    const intent = await createSystemAuditService(env).beginCriticalSystem({
      organizationId: ORGANIZATION.id,
      action: "transfer",
      resourceType: "payment_transfer",
      resourceId: TRANSFER_ID,
    });
    auditIntentId = intent.id;
    await seedTransfer(TRANSFER_ID, auditIntentId);
    await ensureTransferProposal(ledger, await transfer(), Date.parse(NOW));
  });

  it("commits only the winning refusal with its system audit and keeps the payment intent open", async () => {
    const beforePayment = await transfer();
    const beforeProposal = await proposal();
    const results = await Promise.all([
      applyProposalEvent(ledger, beforePayment, beforeProposal, REFUSAL),
      applyProposalEvent(ledger, beforePayment, beforeProposal, {
        ...REFUSAL,
        at: LATER,
        reason: "member_removed",
      }),
    ]);
    expect(results.filter((result) => result.written)).toHaveLength(1);
    const stored = await proposal();
    expect(stored.version).toBe(beforeProposal.version + 1);
    expect(stored.state.authorizationState).toBe("refused");
    const payment = await transfer();
    expect(payment).toMatchObject({ status: "processing", audit_intent_id: auditIntentId });
    expect(payment.provider_data.retainedEvidence).toBe(true);
    expect(await auditEvents()).toEqual([
      expect.objectContaining({
        organization_id: ORGANIZATION.id,
        user_id: null,
        api_key_id: null,
        resource_id: TRANSFER_ID,
        metadata: expect.objectContaining({
          eventType: "proposal_refused",
          projectId,
          proposalId: stored.id,
          provider: "fireblocks",
          at: stored.state.refusal?.at,
          reason: stored.state.refusal?.reason,
          refusedAt: stored.state.refusal?.at,
          providerTransactionId: "provider-transaction",
        }),
      }),
    ]);
    await apply({ ...REFUSAL, at: LAST, reason: "later_refusal" });
    expect((await proposal()).state.refusal).toEqual(stored.state.refusal);
    expect(await auditEvents()).toHaveLength(1);
    expect(await outcomes()).toEqual([]);
  });

  it("records a definitive pre-send refusal after an overlapping worker absence wins the first CAS", async () => {
    // Start this case before provider acceptance, rather than the pending fixture.
    await getDb(env).execute(
      `UPDATE payment_transfers
          SET provider_reference = NULL,
              provider_data = jsonb_build_object('fireblocksTransfer', ?::jsonb,
                'fireblocksSubmissionStartedAt', ?::text)
        WHERE id = ?`,
      [JSON.stringify(BINDING), NOW, TRANSFER_ID]
    );
    await getDb(env).execute(
      `UPDATE custody_proposals
          SET provider_phase = 'submitting', provider_transaction_id = NULL,
              provider_status = NULL, submission_started_at = ?
        WHERE payment_transfer_id = ?`,
      [NOW, TRANSFER_ID]
    );
    const pendingPayment = await transfer();
    const submission = await proposal();
    const absent = await applyProposalEvent(ledger, pendingPayment, submission, {
      type: "observed_absent",
      at: LATER,
    });
    expect(absent.proposal.state.providerPhase).toBe("absent");
    const proof = {
      type: "submission_refused",
      at: LAST,
      error: "Live admission refused before the original provider call",
    } as const satisfies CustodyProposalEvent;
    const stale = await applyProposalEvent(ledger, pendingPayment, submission, proof);
    expect(stale.written).toBe(false);
    expect(stale.transfer.status).toBe("processing");
    const retried = await applyProposalEvent(ledger, stale.transfer, stale.proposal, proof);
    expect(retried.written).toBe(true);
    expect(retried.proposal.state.providerPhase).toBe("not_sent");
    expect(await transfer()).toMatchObject({
      status: "failed",
      provider_reference: null,
      error: proof.error,
      audit_intent_id: null,
    });
    expect(await outcomes()).toEqual([
      {
        status: "failure",
        metadata: expect.objectContaining({ auditIntentId, auditPhase: "outcome" }),
      },
    ]);
  });

  it("does not apply a stale completed observation over a newer authority refusal", async () => {
    const beforePayment = await transfer();
    const snapshot = await proposal();
    await apply(REFUSAL);
    const stale = await applyProposalEvent(ledger, beforePayment, snapshot, COMPLETED);
    expect(stale.written).toBe(false);
    expect(stale.transfer.status).toBe("processing");
    expect(stale.proposal.state.authorizationState).toBe("refused");
    expect(await outcomes()).toEqual([]);
    const fresh = await apply(COMPLETED);
    expect(fresh.transfer.status).toBe("confirmed");
    expect(fresh.proposal.state.authorizationState).toBe("committed_after_refusal");
    expect(hasUnalertedCustodyProposalRefusal(fresh.proposal.state)).toBe(true);
  });

  it("rejects a proposal snapshot from another payment even when versions match", async () => {
    const otherTransferId = "xfr_proposal_ledger_other";
    await seedTransfer(otherTransferId, null);
    const otherPayment = await ledger.repo.getTransferById({
      ...identity(),
      transferId: otherTransferId,
    });
    if (otherPayment === null) throw new Error("Missing second custody proposal test payment");
    const otherProposal = await ensureTransferProposal(ledger, otherPayment, Date.parse(NOW));
    expect(otherProposal.version).toBe((await proposal()).version);
    await expect(
      applyProposalEvent(ledger, await transfer(), otherProposal, REFUSAL)
    ).rejects.toThrow();
    expect((await proposal()).state.authorizationState).toBe("authorized");
    expect(
      (await ledger.proposals.getForTransfer({ ...identity(), transferId: otherTransferId }))?.state
        .authorizationState
    ).toBe("authorized");
    expect(await auditEvents()).toEqual([]);
  });

  it.each(["provider reference", "settlement signature"] as const)(
    "rejects an old revision's changed %s without relying on proposal versioning",
    async (field) => {
      const beforePayment = await transfer();
      const snapshot = await proposal();
      const db = getDb(env);
      if (field === "provider reference") {
        await db.execute("UPDATE payment_transfers SET provider_reference = ? WHERE id = ?", [
          "old-revision-provider-id",
          TRANSFER_ID,
        ]);
      } else {
        await db.execute(
          "UPDATE payment_transfers SET status = 'confirmed', signature = ? WHERE id = ?",
          ["old-revision-settlement-signature", TRANSFER_ID]
        );
      }
      const olderWriterPayment = await transfer();
      expect((await proposal()).version).toBe(snapshot.version);
      await expect(
        applyProposalEvent(ledger, beforePayment, snapshot, COMPLETED, {
          signature: "different-observed-settlement-signature",
        })
      ).rejects.toThrow();
      expect(await proposal()).toEqual(snapshot);
      expect(await transfer()).toEqual(olderWriterPayment);
      expect(await auditEvents()).toEqual([]);
      expect(await outcomes()).toEqual([]);
    }
  );

  it("requires a staged cancellation and keeps an accepted acknowledgment nonterminal", async () => {
    expect((await apply({ type: "cancel_accepted", at: LATER })).written).toBe(false);
    await apply(REFUSAL);
    const staged = await apply({ type: "cancel_requested", at: LATER });
    expect(staged.proposal.state).toMatchObject({
      authorizationState: "cancel_requested",
      cancelRequestedAt: LATER,
      cancelAcknowledgedAt: null,
    });
    expect((await apply({ type: "cancel_requested", at: LAST })).written).toBe(false);
    const retryAt = "2026-11-12T10:06:00.000Z";
    const retried = await apply({ type: "cancel_requested", at: retryAt });
    expect(retried.proposal.state.cancelRequestedAt).toBe(retryAt);
    const accepted = await apply({ type: "cancel_accepted", at: retryAt });
    expect(accepted.transfer).toMatchObject({
      status: "processing",
      audit_intent_id: auditIntentId,
    });
    expect(accepted.proposal.state).toMatchObject({
      providerPhase: "pending",
      authorizationState: "cancel_acknowledged",
      cancelAcknowledgedAt: retryAt,
    });
    expect((await auditEvents()).map((entry) => entry.metadata.eventType)).toEqual([
      "proposal_refused",
      "proposal_cancellation_requested",
      "proposal_cancellation_accepted",
    ]);
    expect(await outcomes()).toEqual([]);
  });

  it("audits only the winning first decline, including after ambiguous retries", async () => {
    await apply(REFUSAL);
    await apply({ type: "cancel_requested", at: LATER });
    // No response was recorded for that call. A later definitive decline is still the first.
    const retryAt = "2026-11-12T10:06:00.000Z";
    await apply({ type: "cancel_requested", at: retryAt });
    const payment = await transfer();
    const staged = await proposal();
    const results = await Promise.all([
      applyProposalEvent(ledger, payment, staged, { type: "cancel_declined", at: retryAt }),
      applyProposalEvent(ledger, payment, staged, { type: "cancel_declined", at: retryAt }),
    ]);
    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect((await proposal()).state).toMatchObject({
      authorizationState: "refused",
      cancelRequestedAt: retryAt,
      cancelDeclinedAt: retryAt,
      refusal: { at: REFUSAL.at, reason: REFUSAL.reason },
    });
    expect((await apply({ type: "cancel_requested", at: retryAt })).written).toBe(false);
    const laterAt = "2026-11-12T10:11:00.000Z";
    await apply({ type: "cancel_requested", at: laterAt });
    const declinedAgain = await apply({ type: "cancel_declined", at: laterAt });
    expect(declinedAgain.written).toBe(true);
    expect((await proposal()).state).toMatchObject({
      authorizationState: "refused",
      cancelRequestedAt: laterAt,
      cancelDeclinedAt: retryAt,
      refusal: { at: REFUSAL.at, reason: REFUSAL.reason },
    });
    expect((await auditEvents()).map((entry) => entry.metadata.eventType)).toEqual([
      "proposal_refused",
      "proposal_cancellation_requested",
      "proposal_cancellation_declined",
    ]);
    expect(await transfer()).toMatchObject({
      status: "processing",
      audit_intent_id: auditIntentId,
    });
    expect(await outcomes()).toEqual([]);
  });

  it.each(SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)(
    "recovers an older revision's %s outcome after refusal without downgrading the payment",
    async (status) => {
      await apply(REFUSAL);
      const snapshot = await proposal();
      const pendingPayment = await transfer();
      await recordOlderRevisionCompletion(status);
      expect((await proposal()).version).toBe(snapshot.version);
      await expect(
        applyProposalEvent(ledger, pendingPayment, snapshot, {
          type: "cancel_requested",
          at: LAST,
        })
      ).rejects.toThrow();
      expect(await proposal()).toEqual(snapshot);
      const recovered = await reconcileRecordedProposalOutcome(
        ledger,
        await transfer(),
        snapshot,
        Date.parse(LAST)
      );
      expect(recovered).not.toBeNull();
      expect(recovered?.written).toBe(true);
      expect(recovered?.transfer.status).toBe(status);
      expect(recovered?.proposal.state).toMatchObject({
        providerPhase: "completed",
        authorizationState: "committed_after_refusal",
        refusal: snapshot.state.refusal,
      });
      expect(await transfer()).toMatchObject({
        status,
        signature: SIGNATURE,
        audit_intent_id: null,
      });
      expect(await ledger.proposals.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual([
        await proposal(),
      ]);
      expect(await outcomes()).toHaveLength(1);
    }
  );

  it.each(["binding", "signature"] as const)(
    "rejects an older terminal payment with invalid %s without changing proposal state",
    async (field) => {
      await apply(REFUSAL);
      const snapshot = await proposal();
      await recordOlderRevisionCompletion("confirmed");
      if (field === "binding") {
        await getDb(env).execute(
          "UPDATE payment_transfers SET provider_data = provider_data || ?::jsonb WHERE id = ?",
          [
            JSON.stringify({
              fireblocksTransfer: { ...BINDING, accountFingerprint: "another-provider-account" },
            }),
            TRANSFER_ID,
          ]
        );
      } else {
        await getDb(env).execute("UPDATE payment_transfers SET signature = ? WHERE id = ?", [
          "not-a-solana-signature",
          TRANSFER_ID,
        ]);
      }
      const recordedPayment = await transfer();
      await expect(
        reconcileRecordedProposalOutcome(ledger, recordedPayment, snapshot, Date.parse(LAST))
      ).rejects.toThrow();
      expect(await proposal()).toEqual(snapshot);
      expect(await transfer()).toEqual(recordedPayment);
      expect(await ledger.proposals.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual(
        []
      );
      expect(await outcomes()).toHaveLength(1);
    }
  );

  it("does not invent a refusal when an older completion wins the re-admission race", async () => {
    const snapshot = await proposal();
    const pendingPayment = await transfer();
    await recordOlderRevisionCompletion("confirmed");
    await expect(applyProposalEvent(ledger, pendingPayment, snapshot, REFUSAL)).rejects.toThrow();
    expect(await proposal()).toEqual(snapshot);
    const recovered = await reconcileRecordedProposalOutcome(
      ledger,
      await transfer(),
      snapshot,
      Date.parse(LAST)
    );
    expect(recovered?.proposal.state).toMatchObject({
      providerPhase: "completed",
      authorizationState: "authorized",
      refusal: null,
    });
    expect(await ledger.proposals.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual([]);
    expect(await auditEvents()).toEqual([]);
    expect(await outcomes()).toHaveLength(1);
  });

  it("keeps completed proposals in the durable critical-alert outbox until audited delivery", async () => {
    await apply(REFUSAL);
    await apply(COMPLETED);
    const completed = await proposal();
    expect(await ledger.proposals.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual([
      completed,
    ]);
    await apply({ type: "alert_delivered", at: LAST });
    expect(await ledger.proposals.listUnalerted({ environment: "sandbox", limit: 10 })).toEqual([]);
    await apply({ type: "alert_delivered", at: LAST });
    expect((await auditEvents()).map((entry) => entry.metadata.eventType)).toEqual([
      "proposal_refused",
      "proposal_refusal_alerted",
    ]);
    expect(await outcomes()).toHaveLength(1);
  });

  it.each([
    "refusal",
    "cancel request",
    "cancel decline",
    "cancel acknowledgment",
    "settlement",
    "alert",
  ] as const)(
    "rolls back proposal, payment and intent mutations when the %s audit fails",
    async (step) => {
      if (step !== "refusal") await apply(REFUSAL);
      if (step === "cancel acknowledgment" || step === "cancel decline") {
        await apply({ type: "cancel_requested", at: LATER });
      }
      if (step === "alert") await apply(COMPLETED);
      const target = (): CustodyProposalEvent => {
        switch (step) {
          case "refusal":
            return REFUSAL;
          case "cancel request":
            return { type: "cancel_requested", at: LATER };
          case "cancel decline":
            return { type: "cancel_declined", at: LAST };
          case "cancel acknowledgment":
            return { type: "cancel_accepted", at: LAST };
          case "settlement":
            return COMPLETED;
          case "alert":
            return { type: "alert_delivered", at: LAST };
          default: {
            const exhaustive: never = step;
            return exhaustive;
          }
        }
      };
      const beforePayment = await transfer();
      const beforeProposal = await proposal();
      const beforeEvents = await auditEvents();
      const beforeOutcomes = await outcomes();
      const write = () =>
        applyProposalEvent(ledger, beforePayment, beforeProposal, target(), {
          signature: step === "settlement" ? "verified-provider-signature" : undefined,
        });
      const restore = await refuseAudit();
      await expect(write()).rejects.toThrow();
      expect(await transfer()).toEqual(beforePayment);
      expect(await proposal()).toEqual(beforeProposal);
      expect(await auditEvents()).toEqual(beforeEvents);
      expect(await outcomes()).toEqual(beforeOutcomes);
      await restore();
      expect((await write()).written).toBe(true);
      if (step === "settlement") {
        expect(await transfer()).toMatchObject({ status: "confirmed", audit_intent_id: null });
        expect((await proposal()).state.authorizationState).toBe("committed_after_refusal");
        expect(await outcomes()).toEqual([
          {
            status: "success",
            metadata: expect.objectContaining({ auditPhase: "outcome", auditIntentId }),
          },
        ]);
      } else {
        expect(await auditEvents()).toHaveLength(beforeEvents.length + 1);
      }
    }
  );
});
