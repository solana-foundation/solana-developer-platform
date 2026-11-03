import {
  type FireblocksAddressEntry,
  readFireblocksAddressBook,
} from "@sdp/custody/provisioning/fireblocks-address-book";
import { resolveFireblocksTransferAsset } from "@sdp/custody/provisioning/fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { isAddress } from "@solana/addresses";
import { getDb } from "@/db/client";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import { badRequest, conflict, notFound, serviceUnavailable } from "@/lib/errors";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { AppContext } from "@/routes/payments/context";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";

const fireblocksRuntime: CustodyProvisioningRuntime = {
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
type FireblocksDestinationState = "approved" | "pending" | "not_whitelisted";
export interface FireblocksDestinationResult {
  state: FireblocksDestinationState;
  assetId: string;
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
async function resolveFireblocksDestinationContext(
  c: AppContext,
  input: FireblocksDestinationInput
) {
  const { organizationId } = getAuth(c);
  const projectId = requireProjectId(c);
  if (!walletAccessAllows(getAuth(c).walletAccess, input.walletId))
    throw notFound("Custody wallet");
  const db = getDb(c.env);
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
    address,
    assetId: asset.id,
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
  return { state, assetId: ctx.assetId };
}
