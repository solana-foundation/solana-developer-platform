import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import { currentMoneyPrincipal, runAsMoneyPrincipal } from "@/lib/money-principal";
import { OperationsService } from "@/services/operations.service";
import { runAsRecordedOperationPrincipal } from "@/services/operations-principal";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  type CreateOperationInput,
  createOperationsRepository,
  type OperationClaim,
  type OperationScope,
} from "./operations.repository";

const ORG = "org_operations";
const USER = "user_operations";
const scope: OperationScope = {
  organizationId: ORG,
  projectId: `prj_${ORG}_sandbox`,
  environment: "sandbox",
};
const repository = () => createOperationsRepository(getDb(env));
function input(overrides: Partial<CreateOperationInput> = {}): CreateOperationInput {
  const result: CreateOperationInput = {
    ...scope,
    source: { ownerAddress: "owner" },
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy_1",
      source: { ownerAddress: "owner" },
      amount: { mint: "mint", value: "1" },
    },
    principal: { kind: "member", userId: USER },
    requestKey: "deposit-1",
    fingerprint: "fingerprint-1",
    prepared: {
      nextAction: {
        type: "sign_transaction",
        transaction: "dW5zaWduZWQ=",
        lastValidBlockHeight: "100",
        expiresAt: null,
      },
      terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
      buildRef: { kind: "earn.transaction", id: "build_1" },
    },
    ...overrides,
  };
  return {
    ...result,
    source:
      overrides.source ??
      (result.intent.kind === "earn.deposit" ? result.intent.source : { ownerAddress: "owner" }),
  };
}
async function createClaim(): Promise<OperationClaim> {
  const { record } = await repository().createOrReplay(input());
  return repository().claimAction(scope, record.operation.id, record.operation);
}
async function expireLease(claim: OperationClaim): Promise<void> {
  await getDb(env).execute(
    "UPDATE operations SET claim_until = now() - interval '1 second' WHERE id = ?",
    [claim.operation.id]
  );
}
const signed = {
  signedTransaction: "c2lnbmVk",
  signature: "signature_1",
  lastValidBlockHeight: "100",
};

describe("durable operations repository", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'operations@example.com', 1, 'active')",
      [USER]
    );
    for (const organizationId of [ORG, "org_operations_other"]) {
      await db.execute(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')",
        [organizationId, organizationId, organizationId]
      );
    }
    await seedDefaultProjects(db, { organizationId: ORG, createdBy: USER, members: [USER] });
  });

  it("concurrent same-key preparation records one immutable operation", async () => {
    const results = await Promise.all([
      repository().createOrReplay(input()),
      repository().createOrReplay(input()),
    ]);
    expect(results[0].record.operation.id).toBe(results[1].record.operation.id);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    await expect(repository().createOrReplay(input({ fingerprint: "different" }))).rejects.toThrow(
      "different operation input"
    );
    await expect(
      repository().createOrReplay(
        input({ principal: { kind: "member", userId: "different-user" } })
      )
    ).rejects.toThrow("different operation input");
  });

  it("exact scope and forced tenant isolation protect status and signed attempts", async () => {
    const claim = await createClaim();
    for (const foreign of [
      { ...scope, organizationId: "org_operations_other" },
      { ...scope, projectId: "different_project" },
      { ...scope, environment: "production" as const },
    ])
      expect(await repository().get(foreign, claim.operation.id)).toBeNull();
    const hidden = await runWithTenantDatabaseIdentity(
      { organizationId: "org_operations_other" },
      () =>
        getDb(env).queryMany("SELECT id FROM operation_attempts WHERE operation_id = ?", [
          claim.operation.id,
        ])
    );
    expect(hidden).toEqual([]);
  });

  it("one exact action wins concurrent execution and a stale version cannot claim", async () => {
    const { record } = await repository().createOrReplay(input());
    const results = await Promise.allSettled([
      repository().claimAction(scope, record.operation.id, record.operation),
      repository().claimAction(scope, record.operation.id, record.operation),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(
      repository().claimAction(scope, record.operation.id, { ...record.operation, version: 2 })
    ).rejects.toThrow("version changed");
  });

  it("lease takeover fences the previous process and retains the same attempt", async () => {
    const old = await createClaim();
    await expireLease(old);
    const current = await repository().claimAction(scope, old.operation.id, old.operation);
    expect(current.attempt.id).toBe(old.attempt.id);
    expect(current.fence).toBeGreaterThan(old.fence);
    await expect(repository().recordSignedAttempt(scope, old, signed)).rejects.toThrow(
      "lease changed"
    );
    expect(await repository().release(scope, old)).toBe(false);
    await repository().recordSignedAttempt(scope, current, signed);
    await expect(
      repository().recordSignedAttempt(scope, current, {
        ...signed,
        signedTransaction: "ZGlmZmVyZW50",
      })
    ).rejects.toThrow("different signed bytes");
  });

  it("dispatch requires durable recovery material and a takeover never authorizes another create", async () => {
    const claim = await createClaim();
    await expect(repository().markDispatchStarted(scope, claim)).rejects.toThrow(
      "Persist signed bytes"
    );
    const binding = {
      provider: "fireblocks" as const,
      externalId: claim.attempt.id,
      connectionId: "connection",
      accountFingerprint: "fingerprint",
      vaultAccountId: "42",
      assetId: "SOL_TEST",
      sourceAddress: "owner",
    };
    await repository().recordProposalBinding(scope, claim, binding);
    await expect(
      repository().recordProposalBinding(scope, claim, { ...binding, vaultAccountId: "43" })
    ).rejects.toThrow("binding changed");
    expect(await repository().markDispatchStarted(scope, claim)).toBe(true);
    expect(await repository().markDispatchStarted(scope, claim)).toBe(false);
    await expireLease(claim);
    const recovered = await repository().claimAction(scope, claim.operation.id, claim.operation);
    expect(recovered.recoveryRequired).toBe(true);
    expect(recovered.attempt.proposalBinding).toEqual(binding);
    expect(await repository().markDispatchStarted(scope, recovered)).toBe(false);
    await repository().recordSignedAttempt(scope, recovered, signed);
  });

  it("cancellation stays pending and prevents a newly dispatched economic action", async () => {
    const claim = await createClaim();
    await repository().recordSignedAttempt(scope, claim, signed);
    const cancelled = await repository().requestCancellation(scope, claim.operation.id);
    expect(cancelled.status).toBe("prepared");
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    expect(
      (await repository().requestCancellation(scope, claim.operation.id)).cancelRequestedAt
    ).toBe(cancelled.cancelRequestedAt);
    await expect(repository().markDispatchStarted(scope, claim)).rejects.toThrow(
      "cancellation was requested"
    );
    await expect(
      repository().transition(scope, claim, {
        status: "cancelled",
        nextAction: null,
        resourceRef: null,
        error: null,
      })
    ).rejects.toThrow("authoritative resource");
  });

  it("retains observation-only recovery after takeover and cannot restore dispatch", async () => {
    const claim = await createClaim();
    await repository().recordSignedAttempt(scope, claim, signed);
    expect((await repository().restrictToObservation(scope, claim)).observationOnly).toBe(true);
    await expireLease(claim);
    const recovered = await repository().claimRecovery(scope, claim.operation.id);
    expect(recovered?.attempt.observationOnly).toBe(true);
    if (recovered === null) throw new Error("Expected recovery claim");
    await expect(repository().markDispatchStarted(scope, recovered)).rejects.toThrow(
      "observation only"
    );
    await expect(
      getDb(env).execute("UPDATE operation_attempts SET observation_only = FALSE WHERE id = ?", [
        recovered.attempt.id,
      ])
    ).rejects.toThrow("irreversible");
  });

  it("rolls back signed bytes, audit admission, and execution acceptance together", async () => {
    const claim = await createClaim();
    await expect(
      getDb(env).transaction(async (tx) => {
        await repository().requestExecutionWithin(tx, scope, claim, "audit-rollback", signed);
        throw new Error("audit append failed");
      })
    ).rejects.toThrow("audit append failed");
    expect(await repository().getAttempt(scope, claim.operation.id)).toMatchObject({
      auditIntentId: null,
      signedTransaction: null,
      signature: null,
      executionRequestedAt: null,
    });
    await repository().release(scope, claim);
    expect(await repository().claimRecovery(scope, claim.operation.id)).toBeNull();
  });

  it("accepts one immutable audited signed outbox and replays it without another admission", async () => {
    const claim = await createClaim();
    expect(
      await getDb(env).transaction((tx) =>
        repository().requestExecutionWithin(tx, scope, claim, "audit-first", signed)
      )
    ).toBe(true);
    expect(
      await getDb(env).transaction((tx) =>
        repository().requestExecutionWithin(tx, scope, claim, "audit-replay", signed)
      )
    ).toBe(false);
    expect(await repository().getAttempt(scope, claim.operation.id)).toMatchObject({
      auditIntentId: "audit-first",
      signedTransaction: signed.signedTransaction,
      signature: signed.signature,
      executionRequestedAt: expect.any(String),
    });
    await expect(
      getDb(env).execute(
        "UPDATE operation_attempts SET audit_intent_id = 'replacement' WHERE id = ?",
        [claim.attempt.id]
      )
    ).rejects.toThrow("audit admission is immutable");
    await expect(
      getDb(env).transaction((tx) =>
        repository().requestExecutionWithin(tx, scope, claim, "audit-replay", {
          ...signed,
          signedTransaction: "different",
        })
      )
    ).rejects.toThrow("different signed bytes");
  });

  it("queues execution durably without dispatch and lets a worker claim it once", async () => {
    const claim = await createClaim();
    const requested = await repository().requestExecution(scope, claim);
    expect(requested.executionRequestedAt).not.toBeNull();
    expect(requested.dispatchStartedAt).toBeNull();
    expect((await repository().requestExecution(scope, claim)).executionRequestedAt).toBe(
      requested.executionRequestedAt
    );
    expect(await repository().claimRecovery(scope, claim.operation.id)).toBeNull();
    await repository().release(scope, claim);
    const worker = await repository().claimRecovery(scope, claim.operation.id);
    expect(worker?.attempt.executionRequestedAt).toBe(requested.executionRequestedAt);
    expect(worker?.recoveryRequired).toBe(false);
    const leased = await repository().get(scope, claim.operation.id);
    expect(Date.parse(leased?.claimUntil ?? "") - Date.now()).toBeGreaterThan(175_000);
    expect(await repository().claimRecovery(scope, claim.operation.id)).toBeNull();
  });

  it("only an unsigned unexecuted action refreshes without authoritative evidence", async () => {
    const claim = await createClaim();
    await repository().release(scope, claim);
    const refreshed = await repository().replacePreparedAction(
      scope,
      claim.operation.id,
      claim.operation,
      input().prepared,
      { kind: "never_dispatched" }
    );
    expect(refreshed.version).toBe(2);
    expect(refreshed.actionId).not.toBe(claim.operation.actionId);
    const current = await repository().claimAction(scope, refreshed.id, refreshed);
    await repository().recordSignedAttempt(scope, current, signed);
    await repository().release(scope, current);
    await expect(
      repository().replacePreparedAction(
        scope,
        current.operation.id,
        current.operation,
        input().prepared,
        { kind: "never_dispatched" }
      )
    ).rejects.toThrow("must be reconciled");
  });

  it("allows one concurrent route preparation without creating an execution attempt", async () => {
    const { record } = await repository().createOrReplay(
      input({
        intent: { kind: "earn.withdraw", positionId: "position_1", amount: { kind: "all" } },
        prepared: {
          ...input().prepared,
          nextAction: { type: "select_option" },
          buildRef: { kind: "earn.withdrawal_options", id: "choices_1" },
        },
      })
    );
    const results = await Promise.allSettled(
      ["direct", "queued"].map((id) =>
        repository().replacePreparedAction(
          scope,
          record.operation.id,
          record.operation,
          { ...input().prepared, buildRef: { kind: "earn.strategy_transaction", id } },
          { kind: "never_dispatched" }
        )
      )
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await repository().get(scope, record.operation.id);
    expect(current?.operation.version).toBe(record.operation.version + 1);
    expect(current?.actionPrincipal).toEqual(record.actionPrincipal);
    expect(current?.operation.intent).toEqual(record.operation.intent);
    expect(await repository().getAttempt(scope, record.operation.id)).toBeNull();
  });

  it("cancellation actions remain executable after cancellation intent is durable", async () => {
    const claim = await createClaim();
    await repository().release(scope, claim);
    await repository().requestCancellation(scope, claim.operation.id);
    const cancellation = await repository().replacePreparedAction(
      scope,
      claim.operation.id,
      claim.operation,
      input().prepared,
      { kind: "never_dispatched" },
      "cancel",
      { kind: "member", userId: USER }
    );
    const cancellationClaim = await repository().claimAction(scope, cancellation.id, cancellation);
    expect(cancellationClaim.purpose).toBe("cancel");
    await repository().recordSignedAttempt(scope, cancellationClaim, signed);
    expect(await repository().markDispatchStarted(scope, cancellationClaim)).toBe(true);
  });

  it("settlement requires its original authoritative row and never reopens terminal state", async () => {
    const claim = await createClaim();
    const resourceRef = { kind: "earn.movement", id: "movement_1" };
    await repository().transition(scope, claim, {
      status: "submitted",
      nextAction: { type: "wait", reason: "confirmation" },
      resourceRef,
      error: null,
    });
    await expect(
      repository().transition(scope, claim, {
        status: "completed",
        nextAction: null,
        resourceRef: { ...resourceRef, id: "movement_2" },
        error: null,
      })
    ).rejects.toThrow("resource changed");
    const completed = await repository().transition(scope, claim, {
      status: "completed",
      nextAction: null,
      resourceRef,
      error: null,
    });
    expect(completed.status).toBe("completed");
    expect(completed.nextAction).toBeNull();
    await expect(
      repository().transition(scope, claim, {
        status: "submitted",
        nextAction: null,
        resourceRef,
        error: null,
      })
    ).rejects.toThrow("status transition");
  });

  it("SQL also prevents rewriting intent and initiating authority", async () => {
    const claim = await createClaim();
    await expect(
      getDb(env).execute(
        "UPDATE operations SET intent = jsonb_set(intent, '{strategyId}', '\"different\"') WHERE id = ?",
        [claim.operation.id]
      )
    ).rejects.toThrow("immutable");
    await expect(
      getDb(env).execute(
        'UPDATE operations SET principal = \'{"kind":"member","userId":"different"}\'::jsonb WHERE id = ?',
        [claim.operation.id]
      )
    ).rejects.toThrow("immutable");
  });

  it("only the named worker restores the exact leased action principal", async () => {
    const claim = await createClaim();
    await expect(
      runAsRecordedOperationPrincipal(env, scope, claim, async () => currentMoneyPrincipal())
    ).rejects.toThrow("restricted to its recovery worker");
    const restored = await runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
      runAsRecordedOperationPrincipal(env, scope, claim, async () => currentMoneyPrincipal())
    );
    expect(restored).toEqual({ kind: "member", userId: USER });
    await expireLease(claim);
    await expect(
      runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
        runAsRecordedOperationPrincipal(env, scope, claim, async () => currentMoneyPrincipal())
      )
    ).rejects.toThrow("lease changed");
  });

  it("service replay normalizes decimal units and cannot change the initiating action identity", async () => {
    const service = new OperationsService(repository());
    const principal = { kind: "member" as const, userId: USER };
    const first = await runAsMoneyPrincipal(principal, () =>
      service.prepare(scope, {
        source: input().source,
        intent: {
          kind: "earn.deposit",
          strategyId: "strategy_1",
          source: { ownerAddress: "owner" },
          amount: { mint: "mint", value: "1.00" },
        },
        requestKey: "normalized",
        prepared: input().prepared,
      })
    );
    const second = await runAsMoneyPrincipal(principal, () =>
      service.prepare(scope, {
        source: input().source,
        intent: {
          kind: "earn.deposit",
          strategyId: "strategy_1",
          source: { ownerAddress: "owner" },
          amount: { mint: "mint", value: "1" },
        },
        requestKey: "normalized",
        prepared: input().prepared,
      })
    );
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.replayed).toBe(true);
    await expect(
      runAsMoneyPrincipal({ kind: "member", userId: "another-user" }, () =>
        service.claimSubmission(scope, first.operation.id, {
          actionId: first.operation.actionId,
          version: 1,
          signedTransaction: signed.signedTransaction,
        })
      )
    ).rejects.toThrow("authenticated action principal");
  });

  it("reclaims accepted queued work without changing its attempt or reviewed authority", async () => {
    const service = new OperationsService(repository());
    const principal = { kind: "member" as const, userId: USER };
    const { operation } = await runAsMoneyPrincipal(principal, () =>
      service.prepare(scope, {
        source: input().source,
        intent: input().intent,
        requestKey: "accepted-replay",
        prepared: {
          ...input().prepared,
          terms: {
            ...input().prepared.terms,
            options: [
              { id: "direct", label: "Direct", settlement: "instant", estimatedSeconds: null },
            ],
          },
        },
      })
    );
    const body = {
      actionId: operation.actionId,
      version: operation.version,
      signedTransaction: signed.signedTransaction,
    };
    const first = await runAsMoneyPrincipal(principal, () =>
      service.claimSubmission(scope, operation.id, body)
    );
    await repository().recordSignedAttempt(scope, first, signed);
    const requested = await repository().requestExecution(scope, first);
    await service.transition(scope, first, {
      status: "queued",
      nextAction: { type: "wait", reason: "Execution queued" },
      resourceRef: null,
      error: null,
    });
    await repository().release(scope, first);
    await getDb(env).execute(
      `UPDATE operations SET terms = jsonb_set(terms, '{expiresAt}', '"2020-01-01T00:00:00.000Z"') WHERE id = ?`,
      [operation.id]
    );
    const replay = await runAsMoneyPrincipal(principal, () =>
      service.claimSubmission(scope, operation.id, body)
    );
    expect(replay.operation.status).toBe("queued");
    expect(replay.attempt).toMatchObject({
      id: first.attempt.id,
      executionRequestedAt: requested.executionRequestedAt,
      dispatchStartedAt: null,
      signedTransaction: signed.signedTransaction,
    });
    await repository().release(scope, replay);
    await expect(
      runAsMoneyPrincipal({ kind: "member", userId: "another-user" }, () =>
        service.claimSubmission(scope, operation.id, body)
      )
    ).rejects.toThrow("authenticated action principal");
    await expect(
      runAsMoneyPrincipal(principal, () =>
        service.claimSubmission(scope, operation.id, { ...body, version: body.version + 1 })
      )
    ).rejects.toThrow("terms version changed");
    const invalidSelection = { ...body, optionId: "different" };
    await expect(
      runAsMoneyPrincipal(principal, () =>
        service.claimSubmission(scope, operation.id, invalidSelection)
      )
    ).rejects.toThrow("Unrecognized key");
    expect(
      await getDb(env).queryOne(
        "SELECT count(*)::int AS count FROM operation_attempts WHERE operation_id = ?",
        [operation.id]
      )
    ).toEqual({ count: 1 });
  });

  it("expired owner-signed attempts remain recoverable while new expired custody proposals refuse", async () => {
    const service = new OperationsService(repository());
    const expired = {
      ...input().prepared,
      terms: { ...input().prepared.terms, expiresAt: "2020-01-01T00:00:00.000Z" },
    };
    const principal = { kind: "member" as const, userId: USER };
    const ownerOperation = await runAsMoneyPrincipal(principal, () =>
      service.prepare(scope, {
        source: input().source,
        intent: input().intent,
        requestKey: "expired-external",
        prepared: expired,
      })
    );
    await expect(
      runAsMoneyPrincipal(principal, () =>
        service.claimSubmission(scope, ownerOperation.operation.id, {
          actionId: ownerOperation.operation.actionId,
          version: 1,
          signedTransaction: signed.signedTransaction,
        })
      )
    ).resolves.toMatchObject({ recoveryRequired: false });
    const custody = await runAsMoneyPrincipal(principal, () =>
      service.prepare(scope, {
        source: input().source,
        intent: input().intent,
        requestKey: "expired-custody",
        prepared: { ...expired, nextAction: { type: "submit" } },
      })
    );
    await expect(
      runAsMoneyPrincipal(principal, () =>
        service.claimSubmission(scope, custody.operation.id, {
          actionId: custody.operation.actionId,
          version: 1,
        })
      )
    ).rejects.toThrow("terms expired");
  });

  it("retains the submission barrier across action versions", async () => {
    const claim = await createClaim();
    await repository().requestExecution(scope, claim, signed);
    await repository().release(scope, claim);
    await getDb(env).execute(
      `UPDATE operations SET action_id = 'new-review', action_version = action_version + 1,
         status = 'prepared', next_action = '{"type":"submit"}'::jsonb WHERE id = ?`,
      [claim.operation.id]
    );
    const current = await repository().get(scope, claim.operation.id);
    if (current === null) throw new Error("Missing operation");
    expect(current.operation.canCancel).toBe(false);
    const before = current.operation;
    for (const mutation of [
      () => repository().cancelPreparation(scope, before.id),
      () => repository().requireRefreshablePreparation(scope, before.id, before),
      () =>
        repository().replacePreparedAction(scope, before.id, before, input().prepared, {
          kind: "never_dispatched",
        }),
    ])
      await expect(mutation()).rejects.toMatchObject({
        details: { reason: "operation_already_submitted" },
      });
    expect((await repository().get(scope, before.id))?.operation).toEqual(before);
  });

  it("sees acceptance committed while a cancellation is waiting for its operation lock", async () => {
    const claim = await createClaim();
    let releaseAcceptance = () => {};
    let signalAccepted = () => {};
    const holdAcceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const accepted = new Promise<void>((resolve) => {
      signalAccepted = resolve;
    });
    const acceptance = getDb(env).transaction(async (tx) => {
      await repository().requestExecutionWithin(tx, scope, claim, "acceptance-race", signed);
      signalAccepted();
      await holdAcceptance;
    });
    await accepted;
    const cancellation = Promise.allSettled([
      repository().cancelPreparation(scope, claim.operation.id),
    ]);
    try {
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await getDb(env).queryOne<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock' AND query LIKE '%FROM operations WHERE id%') AS waiting`
        );
        waiting = result?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      releaseAcceptance();
    }
    await acceptance;
    expect(await cancellation).toMatchObject([
      { status: "rejected", reason: { details: { reason: "operation_already_submitted" } } },
    ]);
    expect(
      (await repository().get(scope, claim.operation.id))?.operation.cancelRequestedAt
    ).toBeNull();
  });

  it("history filters wallets before pagination and requires an explicit owner address", async () => {
    const ownerOperation = await repository().createOrReplay(input());
    const custodyIntent = {
      kind: "earn.deposit" as const,
      strategyId: "strategy_1",
      source: { walletId: "wallet_1" },
      amount: { mint: "mint", value: "1" },
    };
    const custody = await repository().createOrReplay(
      input({ intent: custodyIntent, requestKey: "custody" })
    );
    await repository().createOrReplay(
      input({
        intent: { ...custodyIntent, source: { walletId: "wallet_2" } },
        requestKey: "other-wallet",
      })
    );
    const visible = await repository().list(scope, {
      before: null,
      limit: 10,
      allowedWalletIds: ["wallet_1"],
    });
    expect(visible.map((row) => row.operation.id)).toEqual([custody.record.operation.id]);
    const owner = await repository().list(scope, {
      before: null,
      limit: 10,
      ownerAddress: "owner",
      allowedWalletIds: [],
    });
    expect(owner.map((row) => row.operation.id)).toEqual([ownerOperation.record.operation.id]);
    expect(
      await repository().list(scope, { before: null, limit: 10, ownerAddress: "someone-else" })
    ).toEqual([]);
  });

  it("cancels unexposed choices and custody builds while exposed owner bytes remain uncertain", async () => {
    const ownerOperation = await repository().createOrReplay(input());
    expect(ownerOperation.record.operation.canCancel).toBe(false);
    await expect(
      repository().cancelPreparation(scope, ownerOperation.record.operation.id)
    ).rejects.toMatchObject({ details: { reason: "wallet_transaction_outcome_unknown" } });
    await repository().requestCancellation(scope, ownerOperation.record.operation.id);
    expect(
      await repository().cancelUndispatched(scope, ownerOperation.record.operation.id)
    ).toBeNull();
    const choice = await repository().createOrReplay(
      input({
        requestKey: "unexposed-choice",
        intent: { kind: "earn.withdraw", positionId: "position_1", amount: { kind: "all" } },
        prepared: {
          ...input().prepared,
          nextAction: { type: "select_option" },
          buildRef: { kind: "earn.withdrawal_options", id: "choices_1" },
        },
      })
    );
    expect(choice.record.operation.canCancel).toBe(true);
    const cancelled = await repository().cancelPreparation(scope, choice.record.operation.id);
    expect(cancelled).toMatchObject({ status: "cancelled", canCancel: false });
    expect(await repository().cancelPreparation(scope, choice.record.operation.id)).toEqual(
      cancelled
    );
    const custody = await repository().createOrReplay(
      input({
        requestKey: "custody",
        intent: {
          kind: "earn.deposit",
          strategyId: "strategy_1",
          source: { walletId: "wallet_1" },
          amount: { mint: "mint", value: "1" },
        },
        prepared: { ...input().prepared, nextAction: { type: "submit" } },
      })
    );
    expect(custody.record.operation.canCancel).toBe(true);
    expect(await repository().cancelPreparation(scope, custody.record.operation.id)).toMatchObject({
      status: "cancelled",
      canCancel: false,
    });
  });

  it("blocks preparation changes during a submission claim without treating an empty attempt as accepted", async () => {
    const { record } = await repository().createOrReplay(
      input({
        intent: {
          kind: "earn.deposit",
          strategyId: "strategy_1",
          source: { walletId: "wallet_1" },
          amount: { mint: "mint", value: "1" },
        },
        prepared: { ...input().prepared, nextAction: { type: "submit" } },
      })
    );
    const claim = await repository().claimAction(scope, record.operation.id, record.operation);
    expect((await repository().get(scope, record.operation.id))?.operation.canCancel).toBe(false);
    await expect(repository().cancelPreparation(scope, record.operation.id)).rejects.toMatchObject({
      details: { reason: "operation_in_progress" },
    });
    await expect(
      repository().requireRefreshablePreparation(scope, record.operation.id, record.operation)
    ).rejects.toMatchObject({ details: { reason: "operation_in_progress" } });
    await repository().release(scope, claim);
    expect((await repository().get(scope, record.operation.id))?.operation.canCancel).toBe(true);
    expect(await repository().cancelPreparation(scope, record.operation.id)).toMatchObject({
      status: "cancelled",
      canCancel: false,
    });
    await expect(repository().requestExecution(scope, claim)).rejects.toThrow("lease changed");
  });

  it("cancels queued wallet acceptance locally while an owner-signed message stays uncertain", async () => {
    for (const kind of ["wallet", "address"] as const) {
      const source = kind === "wallet" ? { walletId: "wallet_1" } : { ownerAddress: "owner" };
      const { record } = await repository().createOrReplay(
        input({
          requestKey: `queued-${kind}`,
          intent: {
            kind: "earn.deposit",
            strategyId: "strategy_1",
            source,
            amount: { mint: "mint", value: "1" },
          },
        })
      );
      const claim = await repository().claimAction(scope, record.operation.id, record.operation);
      await repository().requestExecution(scope, claim);
      await repository().transition(scope, claim, {
        status: "queued",
        error: null,
        nextAction: { type: "wait", reason: "Execution queued" },
        resourceRef: null,
      });
      await repository().requestCancellation(scope, record.operation.id);
      const cancelled = await repository().cancelUndispatched(scope, record.operation.id);
      if (kind === "wallet") {
        expect(cancelled).toMatchObject({ status: "cancelled", nextAction: null });
        expect((await repository().get(scope, record.operation.id))?.claimToken).toBeNull();
        await expect(repository().recordSignedAttempt(scope, claim, signed)).rejects.toThrow(
          "lease changed"
        );
        expect(await repository().claimRecovery(scope, record.operation.id)).toBeNull();
      } else expect(cancelled).toBeNull();
    }
  });

  it("cancels only exact known-unsent proposal evidence and retains signed or uncertain attempts", async () => {
    for (const mode of ["known-unsent", "signed", "uncertain", "wrong-attempt"] as const) {
      const { record } = await repository().createOrReplay(input({ requestKey: mode }));
      const claim = await repository().claimAction(scope, record.operation.id, record.operation);
      if (mode === "signed") await repository().recordSignedAttempt(scope, claim, signed);
      await repository().recordProposalBinding(scope, claim, {
        provider: "fireblocks",
        externalId: claim.attempt.id,
        connectionId: "connection",
        accountFingerprint: "fingerprint",
        vaultAccountId: "account",
        assetId: "SOL_TEST",
        sourceAddress: "owner",
      });
      await repository().markDispatchStarted(scope, claim);
      const reference =
        mode === "uncertain"
          ? null
          : {
              kind: "custody.proposal_not_sent",
              id: mode === "wrong-attempt" ? "different-attempt" : claim.attempt.id,
            };
      await repository().transition(scope, claim, {
        status: "awaiting_signature",
        nextAction: { type: "wait", reason: "Refresh review" },
        resourceRef: reference,
        error: { code: "SIGNING_REJECTED", message: "Signing request was not sent" },
      });
      expect(await repository().cancelUndispatched(scope, record.operation.id)).toBeNull();
      await repository().requestCancellation(scope, record.operation.id);
      const result = await repository().cancelUndispatched(scope, record.operation.id);
      if (mode === "known-unsent")
        expect(result).toMatchObject({
          status: "cancelled",
          resourceRef: reference,
          nextAction: null,
        });
      else expect(result).toBeNull();
    }
  });

  it("retains authorized withdrawal source across option selection without relying on a build row", async () => {
    const prepared = {
      ...input().prepared,
      nextAction: { type: "select_option" as const },
      buildRef: { kind: "earn.withdrawal_options", id: "choices_1" },
    };
    const withdrawal = input({
      intent: { kind: "earn.withdraw", positionId: "discovered-selector", amount: { kind: "all" } },
      source: { walletId: "wallet_1" },
      prepared,
    });
    const { record } = await repository().createOrReplay(withdrawal);
    expect(
      (
        await repository().list(scope, { before: null, limit: 10, allowedWalletIds: ["wallet_1"] })
      ).map((row) => row.operation.id)
    ).toEqual([record.operation.id]);
    expect(
      await repository().list(scope, { before: null, limit: 10, ownerAddress: "owner" })
    ).toEqual([]);
    await repository().replacePreparedAction(
      scope,
      record.operation.id,
      record.operation,
      { ...prepared, buildRef: { kind: "earn.queued_transaction", id: "queued_1" } },
      { kind: "never_dispatched" }
    );
    expect((await repository().get(scope, record.operation.id))?.source).toEqual({
      walletId: "wallet_1",
    });
    await expect(
      repository().createOrReplay({ ...withdrawal, source: { ownerAddress: "owner" } })
    ).rejects.toThrow("different operation input");
    await expect(
      getDb(env).execute("UPDATE operations SET source = ?::jsonb WHERE id = ?", [
        JSON.stringify({ ownerAddress: "owner" }),
        record.operation.id,
      ])
    ).rejects.toThrow("immutable");
    await expect(
      repository().createOrReplay(input({ source: { walletId: "wallet_1" } }))
    ).rejects.toThrow("authorized operation source");
  });

  it("finds a signed discovered queue by durable position without crossing project references", async () => {
    const ownerAddress = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
    const db = getDb(env);
    async function seedRequest(projectId: string, suffix: string) {
      const positionId = `position_${suffix}`;
      const requestId = `request_${suffix}`;
      await db.execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment,
           provider, kind, owner_address, vault_address, token_mint, share_mint,
           label, activated_at, cost_basis_known)
         VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', ?, ?, 'token',
           'share', 'Discovered strategy', sdp_iso_now(), FALSE)`,
        [positionId, ORG, projectId, ownerAddress, `strategy_${suffix}`]
      );
      await db.execute(
        `INSERT INTO earn_vault_withdrawal_requests (id, organization_id, project_id,
           environment, provider, position_id, owner_address, vault_address,
           token_mint, share_mint, request_address, status, shares, quoted_assets,
           share_decimals, asset_decimals, discount_bps, maturity_timestamp,
           deadline_timestamp, client_request_id, idempotency_fingerprint,
           creation_signature)
         VALUES (?, ?, ?, 'sandbox', 'veda', ?, ?, ?, 'token', 'share', ?,
           'creating', '10', '9', 6, 6, 25, 1700000060, 1700000120, ?, ?, 'signature')`,
        [
          requestId,
          ORG,
          projectId,
          positionId,
          ownerAddress,
          `strategy_${suffix}`,
          `queue_${suffix}`,
          `key_${suffix}`,
          `fingerprint_${suffix}`,
        ]
      );
      return { positionId, requestId };
    }
    const local = await seedRequest(scope.projectId, "local");
    const sibling = await seedRequest(`prj_${ORG}_production`, "sibling");
    async function linkRequest(requestId: string) {
      const { record } = await repository().createOrReplay(
        input({
          requestKey: requestId,
          source: { ownerAddress },
          intent: {
            kind: "earn.withdraw",
            positionId: `earn_discovered_${requestId}`,
            amount: { kind: "all" },
          },
          prepared: {
            ...input().prepared,
            buildRef: { kind: "earn.queued_transaction", id: `build_${requestId}` },
          },
        })
      );
      const claim = await repository().claimAction(scope, record.operation.id, record.operation);
      await repository().transition(scope, claim, {
        status: "submitted",
        error: null,
        nextAction: { type: "wait", reason: "settlement" },
        resourceRef: { kind: "earn.withdrawal_request", id: requestId },
      });
      return record.operation.id;
    }
    const operationId = await linkRequest(local.requestId);
    await linkRequest(sibling.requestId);
    expect(
      (
        await repository().list(scope, {
          positionId: local.positionId,
          ownerAddress,
          before: null,
          limit: 10,
        })
      ).map((row) => row.operation.id)
    ).toEqual([operationId]);
    expect(
      await repository().list(scope, {
        positionId: sibling.positionId,
        ownerAddress,
        before: null,
        limit: 10,
      })
    ).toEqual([]);
  });

  it("cancelled owner-signed registration claims recovery without permitting a broadcast", async () => {
    const { record } = await repository().createOrReplay(input());
    await repository().requestCancellation(scope, record.operation.id);
    const claim = await runAsMoneyPrincipal({ kind: "member", userId: USER }, () =>
      new OperationsService(repository()).claimSubmission(scope, record.operation.id, {
        actionId: record.operation.actionId,
        version: 1,
        signedTransaction: signed.signedTransaction,
      })
    );
    expect(claim.recoveryRequired).toBe(true);
    await repository().recordSignedAttempt(scope, claim, signed);
    await expect(repository().markDispatchStarted(scope, claim)).rejects.toThrow(
      "cancellation was requested"
    );
    await repository().release(scope, claim);
    expect((await repository().claimRecovery(scope, record.operation.id))?.attempt.id).toBe(
      claim.attempt.id
    );
  });
});
