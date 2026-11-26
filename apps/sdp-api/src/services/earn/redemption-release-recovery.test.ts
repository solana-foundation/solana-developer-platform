import { runInClusterScope } from "@sdp/rpc/scope";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asTransactionalClient, getDb } from "@/db/client";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  createOperationsRepository,
  type OperationScope,
} from "@/db/repositories/operations.repository";
import * as auditServices from "@/services/audit.service";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  parseRedemptionReleaseRecoveryArgs,
  type RedemptionReleaseRecoveryInput,
  recoverCurrentRedemptionRelease,
} from "./redemption-release-recovery";

const scope: OperationScope = {
  organizationId: "org_operator_release",
  projectId: "prj_org_operator_release_sandbox",
  environment: "sandbox",
};
const USER = "user_operator_release";
const OWNER = "11111111111111111111111111111111";
const POSITION = "position_operator_release";
const BUILD = "build_operator_release";
const PDA = "pda_operator_release";
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(1));
const OTHER_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(2));
const operations = () => createOperationsRepository(getDb(env));
const queues = () => createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
const scoped = <T>(work: () => T): T => runInClusterScope(scope, work);
let input: RedemptionReleaseRecoveryInput;
function receipt() {
  return {
    signature: SIGNATURE,
    executionResultKnown: true,
    error: null,
    logs: null,
    blockTime: null,
  };
}
async function state() {
  const db = getDb(env);
  return {
    operation: (await operations().get(scope, input.operationId))?.operation,
    release: await queues().getWalletTransaction({
      organizationId: scope.organizationId,
      transactionId: BUILD,
    }),
    lease: await db.queryOne<{ occupied: boolean }>(
      "SELECT occupied FROM earn_vault_withdrawal_request_pda_leases WHERE environment = ? AND request_address = ?",
      [scope.environment, PDA]
    ),
    audits: await db.queryMany<{ metadata: Record<string, unknown> }>(
      "SELECT metadata::jsonb AS metadata FROM audit_logs WHERE resource_type = 'earn_operation' AND resource_id = ?",
      [input.operationId]
    ),
    movements: await db.queryMany("SELECT id FROM earn_movements"),
  };
}
beforeEach(async () => {
  await seedTestDatabase(env);
  const db = getDb(env);
  await db.execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'operator-release@example.com', 1, 'active')",
    [USER]
  );
  await db.execute(
    "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')",
    [scope.organizationId, scope.organizationId, scope.organizationId]
  );
  await seedDefaultProjects(db, {
    organizationId: scope.organizationId,
    createdBy: USER,
    members: [],
  });
  await db.execute(
    `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider, kind, owner_address, vault_address, share_mint, token_mint, label, activated_at)
    VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, 'vault', 'shares', 'token', 'Hastra', sdp_iso_now())`,
    [POSITION, scope.organizationId, scope.projectId, OWNER]
  );
  await queues().createWalletTransaction({
    ...scope,
    id: BUILD,
    provider: "hastra",
    positionId: POSITION,
    action: "cancel",
    operationOnly: true,
    ownerAddress: OWNER,
    vaultAddress: "vault",
    tokenMint: "token",
    shareMint: "shares",
    requestAddress: PDA,
    mechanism: "operator_redemption",
    shareDecimals: 6,
    assetDecimals: 6,
    intermediateMint: "intermediate",
    unsignedTransaction: "AQ==",
    lastValidBlockHeight: "1000",
  });
  const { record } = await operations().createOrReplay({
    ...scope,
    source: { ownerAddress: OWNER },
    intent: { kind: "earn.withdraw", positionId: POSITION, amount: { kind: "all" } },
    principal: { kind: "member", userId: USER },
    requestKey: BUILD,
    fingerprint: BUILD,
    prepared: {
      nextAction: {
        type: "sign_transaction",
        transaction: "AQ==",
        lastValidBlockHeight: "1000",
        expiresAt: null,
      },
      buildRef: { kind: "earn.queued_transaction", id: BUILD },
      terms: {
        expiresAt: null,
        estimate: null,
        minimum: null,
        fees: null,
        options: [
          {
            id: "release_current_redemption",
            mechanism: "release_current_redemption",
            label: "Release",
            settlement: "instant",
            estimatedSeconds: null,
          },
        ],
      },
    },
  });
  const claim = await operations().claimAction(scope, record.operation.id, record.operation);
  await operations().requestExecution(scope, claim, {
    signedTransaction: "AQ==",
    signature: SIGNATURE,
    lastValidBlockHeight: "1000",
  });
  for (const status of ["queued", "settling"] as const)
    await operations().transition(scope, claim, {
      status,
      nextAction: { type: "wait", reason: "Provider event evidence unavailable" },
      resourceRef: { kind: "earn.redemption_release", id: BUILD },
      error: null,
    });
  await operations().release(scope, claim);
  input = {
    ...scope,
    operationId: record.operation.id,
    transactionId: BUILD,
    attemptId: claim.attempt.id,
    signature: SIGNATURE,
    operator: "security-operator",
    reason: "Finalized release verified independently; provider event evidence unavailable",
    ticket: "PRO-1958",
    evidence: "https://www.notion.so/operator-reviewed-release-evidence",
    attestation: "verified_current_redemption_release",
  };
});
afterEach(() => vi.restoreAllMocks());

describe("operator redemption release recovery", () => {
  it("atomically audits the attested exact finalized release and frees only its PDA fence", async () => {
    const read = vi.fn(async () => receipt());
    expect(await scoped(() => recoverCurrentRedemptionRelease(env, input, read))).toEqual({
      operationId: input.operationId,
      status: "completed",
      replayed: false,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
    const after = await state();
    expect(after.operation).toMatchObject({ status: "completed", error: null });
    expect(after.release?.release_finalized_at).toEqual(expect.any(String));
    expect(after.lease?.occupied).toBe(false);
    expect(after.movements).toEqual([]);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]?.metadata).toMatchObject({
      operation: "recover_current_redemption_release",
      operator: input.operator,
      reason: input.reason,
      ticket: input.ticket,
      evidence: input.evidence,
      attestation: input.attestation,
      signature: SIGNATURE,
    });
  });
  it("replays the same completed identity without another receipt read or audit", async () => {
    const read = vi.fn(async () => receipt());
    await scoped(() => recoverCurrentRedemptionRelease(env, input, read));
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, input, read))
    ).resolves.toMatchObject({ replayed: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect((await state()).audits).toHaveLength(1);
  });
  it.each([
    { transactionId: "another-build" },
    { attemptId: "another-attempt" },
    { signature: OTHER_SIGNATURE },
  ])("refuses another accepted identity before any receipt read (%j)", async (change) => {
    const read = vi.fn(async () => receipt());
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, { ...input, ...change }, read))
    ).rejects.toThrow("exact accepted");
    expect(read).not.toHaveBeenCalled();
    expect((await state()).lease?.occupied).toBe(true);
  });
  it("refuses foreign tenant, project and cluster scope before any receipt read", async () => {
    const read = vi.fn(async () => receipt());
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, { ...input, projectId: "foreign" }, read))
    ).rejects.toThrow("cluster scope");
    await expect(
      scoped(() =>
        recoverCurrentRedemptionRelease(env, { ...input, environment: "production" }, read)
      )
    ).rejects.toThrow("cluster scope");
    await expect(
      scoped(() =>
        recoverCurrentRedemptionRelease(env, { ...input, organizationId: "foreign" }, read)
      )
    ).rejects.toThrow("not found");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...receipt(), signature: OTHER_SIGNATURE },
    { ...receipt(), executionResultKnown: false },
    { ...receipt(), error: { InstructionError: [0, "InvalidAccountData"] } },
  ])("refuses absent, mismatched or unsuccessful finalized receipts (%j)", async (observed) => {
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, input, async () => observed))
    ).rejects.toThrow("finalized success");
    const after = await state();
    expect(after.operation?.status).toBe("settling");
    expect(after.release?.release_finalized_at).toBeNull();
    expect(after.lease?.occupied).toBe(true);
    expect(after.audits).toHaveLength(0);
  });
  it("refuses a failed release before reading evidence or reopening the operation", async () => {
    const claim = await operations().claimRecovery(scope, input.operationId);
    if (claim === null) throw new Error("Expected a recovery claim");
    await operations().transition(scope, claim, {
      status: "failed",
      resourceRef: { kind: "earn.redemption_release", id: BUILD },
      nextAction: null,
      error: { code: "TRANSACTION_FAILED", message: "The release failed on chain" },
    });
    await operations().release(scope, claim);
    const read = vi.fn(async () => receipt());
    await expect(scoped(() => recoverCurrentRedemptionRelease(env, input, read))).rejects.toThrow(
      "Only a settling redemption release"
    );
    expect(read).not.toHaveBeenCalled();
    const after = await state();
    expect(after.operation?.status).toBe("failed");
    expect(after.release?.release_finalized_at).toBeNull();
    expect(after.audits).toHaveLength(0);
  });

  it("refuses an active worker claim without changing its fence", async () => {
    const worker = await operations().claimRecovery(scope, input.operationId);
    if (worker === null) throw new Error("Expected a worker claim");
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, input, async () => receipt()))
    ).rejects.toThrow("leased");
    const current = await operations().get(scope, input.operationId);
    expect(current?.claimToken).toBe(worker.token);
    expect(current?.fence).toBe(worker.fence);
    expect((await state()).release?.release_finalized_at).toBeNull();
  });
  it("rolls back completion, release evidence and cooldown when audit persistence fails", async () => {
    const audit = auditServices.createSystemAuditService(env);
    vi.spyOn(auditServices, "createSystemAuditService").mockReturnValue(audit);
    vi.spyOn(audit, "logSystemWithin").mockImplementation(async (work) =>
      getDb(env).transaction(async (tx) => {
        await work(asTransactionalClient(tx));
        throw new Error("audit persistence failed");
      })
    );
    await expect(
      scoped(() => recoverCurrentRedemptionRelease(env, input, async () => receipt()))
    ).rejects.toThrow("audit persistence failed");
    const after = await state();
    expect(after.operation?.status).toBe("settling");
    expect(after.release?.release_finalized_at).toBeNull();
    expect(after.lease?.occupied).toBe(true);
    expect(after.audits).toHaveLength(0);
    expect((await operations().get(scope, input.operationId))?.claimToken).toBeNull();
  });
  it("parses one explicit identity and rejects ambiguous or unsupported flags", () => {
    const argv = Object.entries(input).flatMap(([name, value]) => [
      `--${name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
      value,
    ]);
    expect(parseRedemptionReleaseRecoveryArgs(argv)).toEqual(input);
    expect(() =>
      parseRedemptionReleaseRecoveryArgs([...argv, "--signature", OTHER_SIGNATURE])
    ).toThrow("Duplicate");
    expect(() =>
      parseRedemptionReleaseRecoveryArgs([...argv, "--settled-amount", "100"])
    ).toThrow();
  });

  it("requires an explicit attestation, operator and HTTPS evidence reference", async () => {
    for (const change of [
      { attestation: "" },
      { operator: "" },
      { evidence: "http://evidence.test" },
    ]) {
      expect(() =>
        parseRedemptionReleaseRecoveryArgs(
          Object.entries({ ...input, ...change }).flatMap(([name, value]) => [
            `--${name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
            value,
          ])
        )
      ).toThrow();
    }
  });
});
