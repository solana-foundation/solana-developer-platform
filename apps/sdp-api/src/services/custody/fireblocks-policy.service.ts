import {
  evaluateFireblocksTransferPolicy,
  FireblocksApiError,
  type FireblocksPolicyRule,
  type FireblocksPolicySnapshot,
  fireblocksPolicyRevision,
  getFireblocksVault,
  isFireblocksDefaultBlock,
  publishFireblocksPolicyDraft,
  readFireblocksAddressBook,
  readFireblocksPolicy,
  readFireblocksPolicyDirectory,
  readFireblocksPolicyDraft,
  writeFireblocksPolicyDraft,
} from "@sdp/custody/provisioning";
import type {
  FireblocksPolicyCheck,
  FireblocksPolicyForm,
  FireblocksPolicyProposalResult,
  FireblocksPolicySelection,
  FireblocksPolicySetup,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  type FireblocksPolicyProposal,
  FireblocksPolicyRepository,
} from "@/db/repositories/fireblocks-policy.repository";
import { getAuth } from "@/lib/auth";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
} from "@/lib/errors";
import type { AppContext } from "@/routes/payments/context";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import {
  resolveFireblocksDestinationContext,
  fireblocksRuntime as runtime,
} from "./fireblocks-address-book.service";

type Context = Awaited<ReturnType<typeof resolveFireblocksDestinationContext>>;
const PREFIX = "Created within SDP — ";
async function policyContext(c: AppContext, input: FireblocksPolicySelection, fresh = false) {
  const ctx = await resolveFireblocksDestinationContext(c, input);
  // Read the policy first: an unauthorized connection does not incur directory/book calls.
  const policy = await readFireblocksPolicy(runtime, ctx.access, fresh);
  if (!policy.valid) throw serviceUnavailable("Fireblocks policy validation is unavailable");
  const entries = await readFireblocksAddressBook(runtime, ctx.access, fresh);
  const matches = entries.filter(
    (entry) =>
      entry.assetId === ctx.assetId &&
      entry.address === ctx.address &&
      entry.status === "APPROVED" &&
      (!entry.activationTime || Date.parse(entry.activationTime) <= Date.now())
  );
  // Ambiguous whitelist ownership must be resolved in Fireblocks, never guessed.
  if (matches.length > 1)
    throw serviceUnavailable("This address has multiple Fireblocks whitelist entries");
  const destination = matches[0] ?? null;
  const match = evaluateFireblocksTransferPolicy(policy.rules, {
    initiatorId: ctx.access.apiKey,
    vaultId: ctx.access.vaultAccountId,
    assetId: ctx.assetId,
    amount: input.amount,
    destination,
  });
  const defaultBlock =
    match.state === "blocked" &&
    policy.rules.some((r) => r.id === match.ruleId && isFireblocksDefaultBlock(r));
  return {
    ...ctx,
    policy,
    destination,
    match,
    canCreate: match.state === "missing" || defaultBlock,
  };
}
export async function checkFireblocksPolicy(
  c: AppContext,
  input: FireblocksPolicySelection
): Promise<FireblocksPolicyCheck> {
  try {
    const ctx = await policyContext(c, input);
    return {
      state: ctx.canCreate ? "missing" : ctx.match.state,
      ruleName: ctx.match.ruleName,
      canConfigure:
        ctx.canCreate &&
        getAuth(c).authType === "clerk" &&
        getAuth(c).permissions.includes("custody:admin"),
    };
  } catch (error) {
    if (error instanceof FireblocksApiError && error.status === 403)
      return { state: "permission_required", canConfigure: false };
    // Retain authorization/tenant/address errors; provider outages are not absence.
    if (error instanceof AppError && error.statusCode < 500) throw error;
    return { state: "unknown", canConfigure: false };
  }
}
async function assertCleanDraft(ctx: Context, active: FireblocksPolicySnapshot) {
  const draft = await readFireblocksPolicyDraft(runtime, ctx.access);
  if (
    draft &&
    (await fireblocksPolicyRevision(runtime, draft.rules)) !==
      (await fireblocksPolicyRevision(runtime, active.rules))
  )
    throw conflict(
      "A Fireblocks transfer-policy draft already exists. Review it in Fireblocks first."
    );
  return draft;
}
function selectionKey(input: FireblocksPolicySelection) {
  return fireblocksPolicyRevision(runtime, {
    walletId: input.walletId,
    accountId: input.accountId,
    counterpartyId: input.counterpartyId,
    token: input.token,
    address: input.address,
  });
}
async function setupContext(c: AppContext, input: FireblocksPolicySelection, resume = false) {
  const ctx = await policyContext(c, input, true);
  if (!ctx.canCreate)
    throw conflict("This policy needs review in Fireblocks. Refresh the payment's policy check.");
  const repo = new FireblocksPolicyRepository(getDb(c.env), ctx.scope);
  const pending = await repo.open(ctx.fingerprint);
  const draft = await readFireblocksPolicyDraft(runtime, ctx.access);
  const clean =
    !draft ||
    (await fireblocksPolicyRevision(runtime, draft.rules)) ===
      (await fireblocksPolicyRevision(runtime, ctx.policy.rules));
  const ownDraft =
    resume &&
    pending?.state === "draft" &&
    pending.selection_key === (await selectionKey(input)) &&
    pending.active_revision === ctx.policy.revision &&
    draft?.valid &&
    pending.draft_id === draft.draftId &&
    pending.draft_revision === draft.revision;
  // A published/reverted draft can release the local lock. Uncertain writes stay locked.
  if (pending && clean && ["draft", "invalid"].includes(pending.state))
    await repo.update(pending.id, "failed");
  else if (pending && !ownDraft)
    throw conflict(
      "An SDP policy proposal is unresolved. Review it in Fireblocks before creating another."
    );
  if (!clean && !ownDraft)
    throw conflict(
      "A Fireblocks transfer-policy draft already exists. Review it in Fireblocks first."
    );
  const [directory, vault] = await Promise.all([
    readFireblocksPolicyDirectory(runtime, ctx.access),
    getFireblocksVault(
      runtime,
      { ...ctx.access, assetId: ctx.access.assetId as "SOL" | "SOL_TEST" },
      ctx.access.vaultAccountId
    ),
  ]);
  const revision = await fireblocksPolicyRevision(runtime, {
    active: ctx.policy.revision,
    draft: draft?.revision ?? null,
  });
  return { ...ctx, directory, vault, revision, pending: ownDraft ? pending : null };
}
export async function getFireblocksPolicySetup(
  c: AppContext,
  input: FireblocksPolicySelection
): Promise<FireblocksPolicySetup> {
  try {
    const ctx = await setupContext(c, input, true);
    return {
      revision: ctx.revision,
      sourceName: ctx.vault.name,
      sourceVaultId: ctx.access.vaultAccountId,
      assetId: ctx.assetId,
      initiatorName: ctx.directory.initiator.name,
      destinationWhitelisted: !!ctx.destination,
      people: ctx.directory.people,
      groups: ctx.directory.groups.filter(
        (g) =>
          g.memberIds.length &&
          g.memberIds.every((id) => ctx.directory.people.some((p) => p.id === id))
      ),
      ...(ctx.pending ? { proposal: result(ctx.pending) } : {}),
      defaults: ctx.pending?.form ?? {
        name: `${PREFIX}${ctx.assetId} from ${ctx.vault.name} to whitelisted addresses`.slice(
          0,
          200
        ),
        destination: "all_whitelisted",
        approvalGroups: [{ users: [], groups: [], threshold: 1 }],
        approvalOperator: "AND",
        signerMode: "SINGLE",
        signerIds: [],
      },
    };
  } catch (error) {
    throw policyError(error);
  }
}
function policyError(error: unknown) {
  if (error instanceof FireblocksApiError) {
    if (error.status === 403)
      return forbidden(
        "Fireblocks policy management requires an API user with Admin or Non-Signing Admin permissions and Policy Editor access."
      );
    return serviceUnavailable(
      `Fireblocks could not process this policy request${error.providerCode === undefined ? "" : ` (code ${error.providerCode})`}. Review it in Fireblocks.`
    );
  }
  return error instanceof AppError
    ? error
    : serviceUnavailable(
        "Fireblocks could not confirm this policy request. Review its status in Fireblocks."
      );
}
function buildRule(
  ctx: Awaited<ReturnType<typeof setupContext>>,
  form: FireblocksPolicyForm,
  id: string
): FireblocksPolicyRule {
  if (!form.name.startsWith(PREFIX))
    throw badRequest("Keep the Created within SDP rule-name prefix");
  const eligible = new Set(ctx.directory.people.map((p) => p.id));
  for (const set of form.approvalGroups) {
    const members = new Set(set.users);
    if (set.users.some((user) => !eligible.has(user)))
      throw badRequest("Choose active Fireblocks approvers");
    for (const groupId of set.groups) {
      const group = ctx.directory.groups.find((g) => g.id === groupId);
      if (!group?.memberIds.length || group.memberIds.some((user) => !eligible.has(user)))
        throw badRequest("Choose an approved group containing eligible human approvers");
      for (const user of group.memberIds) members.add(user);
    }
    if (set.threshold > members.size || set.threshold < 1)
      throw badRequest("Approval threshold exceeds the selected approver set");
  }
  if (
    (form.signerMode === "SINGLE" && form.signerIds.length !== 1) ||
    !form.signerIds.length ||
    form.signerIds.some((id) => !ctx.directory.people.some((p) => p.id === id && p.canSign))
  )
    throw badRequest("Choose active human designated signers; the API initiator cannot sign");
  if (form.destination === "selected_whitelisted" && !ctx.destination)
    throw badRequest("Whitelist this destination in Fireblocks first");
  const destination =
    form.destination === "selected_whitelisted" && ctx.destination
      ? {
          operator: "INCLUDES",
          addressType: "WHITELISTED",
          ids: [
            {
              id: ctx.destination.walletId,
              type: "UNMANAGED",
              subType: ctx.destination.walletType === "INTERNAL_WALLET" ? "INTERNAL" : "EXTERNAL",
            },
          ],
        }
      : {
          operator: "INCLUDES",
          addressType: form.destination === "one_time" ? "ONE_TIME" : "WHITELISTED",
          type: [form.destination === "one_time" ? "ONE_TIME_ADDRESS" : "UNMANAGED"],
        };
  return {
    id,
    name: form.name,
    policyEngineVersion: "v2",
    type: "TRANSFER",
    initiator: { operator: "INCLUDES", users: [ctx.directory.initiator.id] },
    source: { operator: "INCLUDES", ids: [{ type: "VAULT", id: ctx.access.vaultAccountId }] },
    destination,
    asset: { nftTransfer: false, operator: "INCLUDES", assetTypes: [ctx.assetId] },
    amount: { currency: "USD", range: { min: "0" } },
    verdict: {
      action: "2-TIER",
      approvers: {
        canInitiatorApprove: false,
        allowOperatorAsAuthorizer: false,
        operator: form.approvalOperator,
        approvalGroups: form.approvalGroups,
      },
      designatedSigners: { type: form.signerMode, users: form.signerIds },
    },
  };
}
function result(proposal: FireblocksPolicyProposal): FireblocksPolicyProposalResult {
  return {
    proposalId: proposal.id,
    state:
      proposal.state === "preparing" || proposal.state === "submitting"
        ? "unknown"
        : proposal.state,
    ...(proposal.draft_id ? { draftId: proposal.draft_id } : {}),
  };
}
function addRule(rules: FireblocksPolicyRule[], rule: FireblocksPolicyRule) {
  const index = rules.findIndex(isFireblocksDefaultBlock);
  const next = [...rules];
  next.splice(index < 0 ? next.length : index, 0, rule);
  return next.map((r, i) => ({ ...r, index: i + 1 }));
}
export async function saveFireblocksPolicyDraft(
  c: AppContext,
  input: FireblocksPolicySelection,
  form: FireblocksPolicyForm,
  revision: string,
  requestId: string
): Promise<FireblocksPolicyProposalResult> {
  const access = await resolveFireblocksDestinationContext(c, input);
  const repo = new FireblocksPolicyRepository(getDb(c.env), access.scope);
  const requestHash = await fireblocksPolicyRevision(runtime, { input, form, revision });
  const existing = await repo.existing(requestId);
  if (existing) {
    if (
      existing.request_hash !== requestHash ||
      existing.account_fingerprint !== access.fingerprint
    )
      throw conflict("Policy request changed");
    return result(existing);
  }
  const ctx = await setupContext(c, input).catch((error) => {
    throw policyError(error);
  });
  if (ctx.revision !== revision)
    throw conflict("The Fireblocks policy changed. Refresh and review the rule again.");
  const newRule = buildRule(ctx, form, crypto.randomUUID());
  const rules = addRule(ctx.policy.rules, newRule);
  const audit = new AuditService(getDb(c.env));
  const intent = await audit.beginCritical(c, {
    organizationId: ctx.scope.organizationId,
    action: "create",
    resourceType: "custody_connection",
    resourceId: ctx.scope.connectionId,
    metadata: {
      event: "fireblocks_policy_draft_requested",
      ruleId: newRule.id,
      connectionId: ctx.scope.connectionId,
      name: form.name,
      sourceVaultId: ctx.access.vaultAccountId,
      assetId: ctx.assetId,
      destination: form.destination,
      approvalGroups: form.approvalGroups,
      signerIds: form.signerIds,
      activeRevision: ctx.policy.revision,
    },
  });
  const proposal = await repo.claim(
    requestId,
    requestHash,
    ctx.fingerprint,
    ctx.policy.revision,
    await selectionKey(input),
    form
  );
  if (!proposal)
    throw conflict("Another SDP policy proposal is already in progress. Review it in Fireblocks.");
  try {
    // Fireblocks offers no conditional PUT. Re-read immediately before writing and
    // never overwrite a pre-existing external draft. Console edits must be serialized.
    const latest = await readFireblocksPolicy(runtime, ctx.access, true);
    const currentDraft = await assertCleanDraft(ctx, latest);
    const currentRevision = await fireblocksPolicyRevision(runtime, {
      active: latest.revision,
      draft: currentDraft?.revision ?? null,
    });
    if (currentRevision !== revision) {
      await repo.update(proposal.id, "failed");
      throw conflict("The Fireblocks policy changed before saving. Refresh and review it again.");
    }
    const draft = await writeFireblocksPolicyDraft(
      runtime,
      ctx.access,
      rules,
      `${proposal.id}-draft`
    );
    const expected = await fireblocksPolicyRevision(runtime, rules);
    const actual = await fireblocksPolicyRevision(runtime, draft.rules);
    // A successful HTTP response must contain exactly the rule set we reviewed.
    const state = draft.valid && expected === actual ? "draft" : "invalid";
    await repo.update(proposal.id, state, draft.draftId, draft.revision);
    await audit.completeCritical(c, intent, {
      status: "success",
      metadata: {
        event: "fireblocks_policy_draft_saved",
        proposalId: proposal.id,
        draftId: draft.draftId,
        valid: state === "draft",
      },
    });
    return { proposalId: proposal.id, state, draftId: draft.draftId };
  } catch (error) {
    const definite =
      (error instanceof FireblocksApiError && [400, 401, 403, 422].includes(error.status)) ||
      (error instanceof Error && "statusCode" in error && error.statusCode === 409);
    await repo.update(proposal.id, definite ? "failed" : "unknown");
    getLogger().warn(
      {
        proposalId: proposal.id,
        httpStatus: error instanceof FireblocksApiError ? error.status : undefined,
      },
      "fireblocks_policy_draft_unconfirmed"
    );
    if (definite)
      await audit.completeCritical(c, intent, {
        status: "failure",
        metadata: { event: "fireblocks_policy_draft_rejected", proposalId: proposal.id },
      });
    throw policyError(error);
  }
}
export async function submitFireblocksPolicyDraft(
  c: AppContext,
  input: FireblocksPolicySelection,
  proposalId: string
): Promise<FireblocksPolicyProposalResult> {
  const ctx = await resolveFireblocksDestinationContext(c, input);
  const repo = new FireblocksPolicyRepository(getDb(c.env), ctx.scope);
  const proposal = await repo.find(proposalId);
  if (!proposal || proposal.account_fingerprint !== ctx.fingerprint)
    throw notFound("Policy proposal");
  if (proposal.state !== "draft") return result(proposal);
  const [active, draft] = await Promise.all([
    readFireblocksPolicy(runtime, ctx.access, true),
    readFireblocksPolicyDraft(runtime, ctx.access),
  ]).catch((error) => {
    throw policyError(error);
  });
  if (
    active.revision !== proposal.active_revision ||
    !draft?.valid ||
    !draft.draftId ||
    draft.draftId !== proposal.draft_id ||
    draft.revision !== proposal.draft_revision
  )
    throw conflict("The policy or draft changed in Fireblocks. Review it there before publishing.");
  const audit = new AuditService(getDb(c.env));
  const intent = await audit.beginCritical(c, {
    organizationId: ctx.scope.organizationId,
    action: "update",
    resourceType: "custody_connection",
    resourceId: ctx.scope.connectionId,
    metadata: {
      event: "fireblocks_policy_publish_requested",
      proposalId: proposal.id,
      draftId: draft.draftId,
    },
  });
  if (!(await repo.claimPublish(proposal.id)))
    throw conflict("This draft has already been submitted");
  try {
    const status = await publishFireblocksPolicyDraft(
      runtime,
      ctx.access,
      draft.draftId,
      `${proposal.id}-publish`
    );
    const state = ["SUCCESS", "PENDING", "PENDING_CONSOLE_APPROVAL", "AWAITING_QUORUM"].includes(
      status
    )
      ? "submitted"
      : "unknown";
    await repo.update(proposal.id, state);
    await audit.completeCritical(c, intent, {
      status: "success",
      metadata: { event: "fireblocks_policy_publish_response", providerStatus: status },
    });
    return { proposalId: proposal.id, state, draftId: draft.draftId };
  } catch (error) {
    await repo.update(proposal.id, "unknown");
    throw policyError(error);
  }
}
