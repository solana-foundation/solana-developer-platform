import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { isAddress } from "@solana/addresses";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { AppContext } from "@/routes/payments/context";
import type { DestinationState } from "@/services/domain/signing/admitted-proposer";
import { createOrgTransferProposerForCustodyWallet } from "@/services/solana/signer";

/**
 * Pay's Fireblocks destination advisory. It resolves the wallet through the custody waist, as the
 * payment itself will (PRO-2435 D2), so the advisory and the payment share one availability
 * check and one asset rule, and no Fireblocks credential leaves the waist.
 */
export interface FireblocksDestinationInput {
  walletId: string;
  counterpartyId: string;
  accountId: string;
  token: string;
  address: string;
}
export interface FireblocksDestinationResult {
  state: DestinationState;
  assetId: string;
}
async function resolveFireblocksDestinationContext(
  c: AppContext,
  input: FireblocksDestinationInput
) {
  const { organizationId } = getAuth(c);
  const projectId = requireProjectId(c);
  if (!walletAccessAllows(getAuth(c).walletAccess, input.walletId))
    throw notFound("Custody wallet");
  const proposer = await createOrgTransferProposerForCustodyWallet<"payments">(
    c.env,
    organizationId,
    projectId,
    input.walletId,
    "payments.transfer"
  );
  if (!proposer) throw badRequest("An active Fireblocks BYOK wallet is required");
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
  return { proposer, address };
}
export async function checkFireblocksDestination(
  c: AppContext,
  input: FireblocksDestinationInput
): Promise<FireblocksDestinationResult> {
  const { proposer, address } = await resolveFireblocksDestinationContext(c, input);
  return proposer.checkDestination({
    token: input.token,
    native: input.token === "SOL" || input.token === SOL_MINT,
    address,
  });
}
