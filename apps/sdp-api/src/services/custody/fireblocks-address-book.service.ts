import {
  type CustodyProvisioningRuntime,
  createFireblocksExternalWallet,
  type FireblocksAddressEntry,
  FireblocksApiError,
  proposeFireblocksAddress,
  readFireblocksAddressBook,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/provisioning";
import { isAddress } from "@sdp/solana/address";
import { SOL_MINT, wellKnownMint } from "@sdp/types";
import { getDb } from "@/db";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories";
import {
  FireblocksAddressBookRepository,
  type FireblocksBookScope,
} from "@/db/repositories/fireblocks-address-book.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { badRequest, conflict, notFound, serviceUnavailable } from "@/lib/errors";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { AppContext } from "@/routes/payments/context";
import { assertPaymentWalletExactAccess } from "@/routes/payments/wallets";
import { getLogger } from "@/runtime/logger";
import { assertFreshApiKeyCustodyWalletAccess } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";

export const fireblocksRuntime: CustodyProvisioningRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (data) => crypto.getRandomValues(new Uint8Array(data)),
  sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
};
type Access = NonNullable<
  Awaited<ReturnType<CustodyRuntimeTargets["getFireblocksTransferAccess"]>>
>;
export interface FireblocksDestinationInput {
  walletId: string;
  counterpartyId: string;
  accountId: string;
  token: string;
  address: string;
}
export type FireblocksDestinationState =
  | "approved"
  | "pending"
  | "not_whitelisted"
  | "unknown"
  | "failed";
export interface FireblocksDestinationResult {
  state: FireblocksDestinationState;
  assetId: string;
  failureReason?: "credentials" | "permissions" | "request";
  providerCode?: number;
}
function whitelistFailureReason(status: number): FireblocksDestinationResult["failureReason"] {
  if (status === 401) return "credentials";
  if (status === 403) return "permissions";
  return "request";
}
function scope(access: Access, organizationId: string, projectId: string): FireblocksBookScope {
  return { connectionId: access.connectionId, organizationId, projectId };
}
function nativeAsset(access: Access): "SOL" | "SOL_TEST" {
  if (access.assetId !== "SOL" && access.assetId !== "SOL_TEST")
    throw badRequest("Unsupported Fireblocks network");
  return access.assetId;
}
function entryState(
  entries: FireblocksAddressEntry[],
  assetId: string,
  address: string
): FireblocksDestinationState {
  const matches = entries.filter((entry) => entry.assetId === assetId && entry.address === address);
  const approved = matches.filter((entry) => entry.status === "APPROVED");
  if (
    approved.some(
      (entry) =>
        !entry.activationTime ||
        (Number.isFinite(Date.parse(entry.activationTime)) &&
          Date.parse(entry.activationTime) <= Date.now())
    )
  )
    return "approved";
  if (approved.length || matches.some((entry) => entry.status === "WAITING_FOR_APPROVAL"))
    return "pending";
  return "not_whitelisted";
}
export async function resolveFireblocksDestinationContext(
  c: AppContext,
  input: FireblocksDestinationInput
) {
  const { organizationId } = getAuth(c);
  const projectId = requireProjectId(c);
  assertPaymentWalletExactAccess(c, input.walletId, ["wallets:read"]);
  const db = getDb(c.env);
  await assertFreshApiKeyCustodyWalletAccess(db, getAuth(c), input.walletId, ["wallets:read"]);
  const access = await new CustodyRuntimeTargets(db, c.env, new Map()).getFireblocksTransferAccess({
    organizationId,
    projectId,
    custodyWalletId: input.walletId,
    forSubmission: true,
  });
  if (!access?.accountFingerprint) throw badRequest("An active Fireblocks BYOK wallet is required");
  const [account, contact] = await Promise.all([
    createCounterpartyAccountsRepository(
      c.env,
      getRequestTenantScope(c)
    ).getCounterpartyAccountById({
      counterpartyAccountId: input.accountId,
      counterpartyId: input.counterpartyId,
      organizationId,
      projectId,
    }),
    createCounterpartiesRepository(c.env, getRequestTenantScope(c)).getCounterpartyById({
      counterpartyId: input.counterpartyId,
      organizationId,
      projectId,
    }),
  ]);
  if (!account || !contact || account.status !== "active" || contact.status !== "active")
    throw notFound("Contact address");
  const address = account.details.address;
  if (
    account.account_kind !== "crypto_wallet" ||
    account.details.network !== "solana" ||
    typeof address !== "string" ||
    !isAddress(address)
  )
    throw badRequest("A Solana contact address is required");
  if (address !== input.address)
    throw conflict("Contact address changed. Select the destination again.");
  const native = nativeAsset(access);
  const mint = wellKnownMint("USDC", native === "SOL" ? "mainnet-beta" : "devnet");
  if (!mint) throw badRequest("Unsupported Fireblocks network");
  const isSol = input.token === "SOL" || input.token === SOL_MINT;
  if (!isSol && input.token !== mint)
    throw badRequest("Fireblocks payments support SOL and USDC only");
  const asset = await resolveFireblocksTransferAsset(
    fireblocksRuntime,
    access,
    native,
    isSol ? null : mint
  );
  return {
    access,
    fingerprint: access.accountFingerprint,
    scope: scope(access, organizationId, projectId),
    address,
    assetId: asset.id,
    name: (account.label || contact.display_name).slice(0, 200),
    repo: new FireblocksAddressBookRepository(db),
  };
}
async function loadAddressBook(access: Access, fresh = false) {
  try {
    return await readFireblocksAddressBook(fireblocksRuntime, access, fresh);
  } catch {
    throw serviceUnavailable("Couldn’t check the Fireblocks address book. Try again later.");
  }
}
export async function checkFireblocksDestination(
  c: AppContext,
  input: FireblocksDestinationInput
): Promise<FireblocksDestinationResult> {
  const ctx = await resolveFireblocksDestinationContext(c, input);
  const entries = await loadAddressBook(ctx.access);
  const state = entryState(entries, ctx.assetId, ctx.address);
  if (state !== "not_whitelisted") return { state, assetId: ctx.assetId };
  const proposal = await ctx.repo.proposal(ctx.scope, ctx.assetId, ctx.address);
  return {
    state: proposal && proposal.state !== "failed" ? "unknown" : state,
    assetId: ctx.assetId,
  };
}
export async function requestFireblocksWhitelist(
  c: AppContext,
  input: FireblocksDestinationInput
): Promise<FireblocksDestinationResult> {
  const ctx = await resolveFireblocksDestinationContext(c, input);
  // Always check the live book before an explicit proposal; cache misses never mean absence.
  const entries = await loadAddressBook(ctx.access, true);
  const state = entryState(entries, ctx.assetId, ctx.address);
  if (state !== "not_whitelisted") return { state, assetId: ctx.assetId };
  const audit = new AuditService(getDb(c.env));
  const intent = await audit.beginCritical(c, {
    organizationId: ctx.scope.organizationId,
    action: "create",
    resourceType: "counterparty",
    resourceId: input.counterpartyId,
    metadata: {
      event: "fireblocks_whitelist_requested",
      projectId: ctx.scope.projectId,
      connectionId: ctx.scope.connectionId,
      accountId: input.accountId,
      assetId: ctx.assetId,
    },
  });
  const proposal = await ctx.repo.claimProposal(
    ctx.scope,
    ctx.fingerprint,
    ctx.assetId,
    ctx.address
  );
  if (!proposal) {
    const existing = await ctx.repo.proposal(ctx.scope, ctx.assetId, ctx.address);
    if (!existing || existing.account_fingerprint !== ctx.access.accountFingerprint)
      throw conflict("Fireblocks connection changed");
    await audit.completeCritical(c, intent, {
      status: "success",
      metadata: { event: "fireblocks_whitelist_existing" },
    });
    return { state: existing.state === "failed" ? "failed" : "unknown", assetId: ctx.assetId };
  }
  let providerStep = "create_wallet";
  try {
    const walletId =
      proposal.wallet_id ??
      (await createFireblocksExternalWallet(
        fireblocksRuntime,
        ctx.access,
        ctx.name,
        `${proposal.id}-wallet`
      ));
    await ctx.repo.updateProposal(ctx.scope, proposal.id, "adding_address", walletId);
    providerStep = "add_address";
    const status = await proposeFireblocksAddress(
      fireblocksRuntime,
      ctx.access,
      walletId,
      ctx.assetId,
      ctx.address,
      `${proposal.id}-address`
    );
    const rejected = ["FAILED", "CANCELLED", "REJECTED"].includes(status);
    await ctx.repo.updateProposal(
      ctx.scope,
      proposal.id,
      rejected ? "failed" : "submitted",
      walletId
    );
    await audit.completeCritical(c, intent, {
      status: "success",
      metadata: {
        event: "fireblocks_whitelist_submitted",
        proposalId: proposal.id,
        providerStatus: status,
      },
    });
    // Even APPROVED may have an activation delay; the next book read decides readiness.
    return { state: rejected ? "failed" : "pending", assetId: ctx.assetId };
  } catch (error) {
    const definite =
      error instanceof FireblocksApiError && [400, 401, 403, 422].includes(error.status);
    const diagnostics = {
      event: definite ? "fireblocks_whitelist_rejected" : "fireblocks_whitelist_unconfirmed",
      providerStep,
      proposalId: proposal.id,
      ...(error instanceof FireblocksApiError
        ? {
            httpStatus: error.status,
            providerCode: error.providerCode,
            providerRequestId: error.requestId,
          }
        : {}),
    };
    getLogger().warn(diagnostics, "fireblocks_whitelist_request_failed");
    await ctx.repo.updateProposal(ctx.scope, proposal.id, definite ? "failed" : "unknown");
    if (definite)
      await audit.completeCritical(c, intent, {
        status: "failure",
        metadata: diagnostics,
      });
    return {
      state: definite ? "failed" : "unknown",
      assetId: ctx.assetId,
      ...(definite
        ? {
            failureReason: whitelistFailureReason(error.status),
            providerCode: error.providerCode,
          }
        : {}),
    };
  }
}
export function fireblocksContactSyncEnabled(env: Env): boolean {
  return (
    env.FIREBLOCKS_CONTACT_SYNC_ENABLED === undefined ||
    env.FIREBLOCKS_CONTACT_SYNC_ENABLED === "true"
  );
}
/** Host-controlled inbound sync. Never proposes whitelisting or changes Fireblocks. */
export async function syncFireblocksContacts(
  env: Env,
  project?: { organizationId: string; projectId: string }
): Promise<void> {
  if (!fireblocksContactSyncEnabled(env)) return;
  const db = getDb(env);
  const repo = new FireblocksAddressBookRepository(db);
  const connections = await repo.connections(project);
  await mapSettledWithConcurrency(connections, 3, async (connection) => {
    const scope = {
      organizationId: connection.organization_id,
      projectId: connection.project_id,
      connectionId: connection.connection_id,
    };
    try {
      const lease = await repo.claimSync(scope);
      if (!lease) return;
      const access = await new CustodyRuntimeTargets(
        db,
        env,
        new Map()
      ).getFireblocksTransferAccess({
        ...scope,
        custodyWalletId: connection.wallet_id,
        forSubmission: true,
      });
      if (!access) return;
      const native = nativeAsset(access);
      const entries = await readFireblocksAddressBook(fireblocksRuntime, access);
      const mint = wellKnownMint("USDC", native === "SOL" ? "mainnet-beta" : "devnet");
      if (!mint) return;
      const usdc = entries.some((entry) => entry.assetId !== native)
        ? await resolveFireblocksTransferAsset(fireblocksRuntime, access, native, mint)
        : null;
      const solana = entries.filter(
        (entry) =>
          (entry.assetId === native || entry.assetId === usdc?.id) && isAddress(entry.address)
      );
      await repo.importContacts(scope, lease, solana);
    } catch {
      getLogger().warn(
        { connectionId: connection.connection_id },
        "fireblocks_contact_sync_unavailable"
      );
    }
  });
}
