/**
 * The single access-policy seam for Private Channels value movement.
 *
 * Deposits, withdrawals and member transfers all answer the same question before
 * anything is signed: may value move out of THIS wallet, to THIS destination, on
 * THIS instance? Holding `payments:write` on the project is not enough — it only
 * proves the caller may move project funds at all. The control that actually
 * binds a wallet to the channel is `private_channel_verified_wallets`: the record
 * that the wallet completed the challenge → sign → verify handshake under the
 * project's SPC principal on this instance. Wallet verification is documented as
 * "the gate for money-movement" on the router, and this module is where that gate
 * is applied.
 *
 * Why it has to be here rather than in the service: the request context is the
 * only place that knows the tenant, the project and its active instance. A
 * service handed a `CustodyWallet` can check that the resolved signer matches it
 * (both deposit and withdraw do), but that only proves SDP can sign for the
 * wallet — never that the wallet is enrolled in Private Channels at all. Without
 * this seam, any project custody wallet could be named as a deposit source, or
 * have its channel balance burned, without ever having been enrolled.
 */

import { isAddress } from "@sdp/solana/address";
import type { PrivateChannelInstance } from "@sdp/types";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  mapPrivateChannelInstanceRow,
  type PrivateChannelUserRow,
  type PrivateChannelVerifiedWalletRow,
} from "@/db/repositories";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, forbidden, walletNotFound } from "@/lib/errors";
import { createSigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";
import {
  getPrivateChannelUserRepository,
  getPrivateChannelVerifiedWalletRepository,
} from "./context";
import { requireActiveInstance } from "./helpers";

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: This is the public Solana Memo program address.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Program, system and connected-instance addresses, which must never be an
 * endpoint of a value movement.
 *
 * None of these has a private key — the program ids are fixed accounts and the
 * escrow instance is a PDA — so value sent to one is unrecoverable. On a
 * transfer both endpoints are verified wallets and reaching one should be
 * impossible; on a deposit recipient or a withdrawal destination the address can
 * be caller-supplied, which is exactly why the invariant is checked rather than
 * assumed.
 */
export function unsafeAddresses(instance: PrivateChannelInstance): ReadonlySet<string> {
  return new Set([
    SYSTEM_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    MEMO_PROGRAM_ADDRESS,
    instance.escrowProgramId,
    instance.withdrawProgramId,
    instance.escrowInstanceAddr,
  ]);
}

/** Caller identity resolved against the project's active instance. */
export interface PrivateChannelActorContext {
  auth: ApiKeyContext;
  projectId: string;
  instance: PrivateChannelInstance;
  actor: PrivateChannelUserRow;
}

/**
 * Resolve the acting SPC principal for a value movement on the project's active
 * instance. Instance-scoped, with no channel: deposits and withdrawals move
 * value between a custody wallet and the instance escrow, and are not made
 * inside a logical channel.
 *
 * Resolved as the project's DEFAULT PRINCIPAL, the same way `transfer-access`
 * resolves it, and deliberately not by the caller's user id. A
 * `private_channel_users` row is a project-level principal that wallets enrol
 * under; since #1558 it carries no user id at all, so looking one up by
 * `auth.userId` finds nothing and every deposit and withdrawal on a project
 * created after that change would answer 403.
 */
export async function resolvePrivateChannelActor(
  c: AppContext
): Promise<PrivateChannelActorContext> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const instanceRow = await requireActiveInstance(c);
  const actor = await getPrivateChannelUserRepository(c).findDefaultPrincipal(
    { organizationId: auth.organizationId, projectId },
    instanceRow.id
  );
  if (!actor) {
    throw forbidden("This project has no active Private Channels principal.");
  }

  return { auth, projectId, instance: mapPrivateChannelInstanceRow(instanceRow), actor };
}

/** The project's custody wallets, fetched once per request. */
function loadProjectWallets(
  c: AppContext,
  context: PrivateChannelActorContext
): Promise<CustodyWallet[]> {
  return createSigningService(c.env).getWalletsWithProviders(
    context.auth.organizationId,
    context.projectId,
    { includeAllProviders: true }
  );
}

/**
 * The custody wallet a value movement spends from, held against its enrolment.
 *
 * Three facts have to agree, and each rules out a different mistake: the wallet
 * must exist in the project's custody scope (else it belongs to another tenant),
 * it must be verified under the project's principal on THIS instance (else it is
 * a project wallet that was never enrolled in Private Channels), and the
 * verification's pubkey must still equal the wallet's (else a re-keyed custody
 * wallet would ride an old proof of control).
 */
export async function resolveVerifiedSourceWallet(
  c: AppContext,
  context: PrivateChannelActorContext,
  walletId: string,
  wallets: CustodyWallet[]
): Promise<{ wallet: CustodyWallet; verified: PrivateChannelVerifiedWalletRow }> {
  const wallet = wallets.find(
    (candidate) => candidate.walletId === walletId || candidate.publicKey === walletId
  );
  if (!wallet) {
    throw walletNotFound();
  }

  const verifiedWallets = await getPrivateChannelVerifiedWalletRepository(c).listByUserAndInstance(
    context.actor.id,
    context.instance.id
  );
  const verified = verifiedWallets.find(
    (candidate) => candidate.wallet_id === wallet.walletId && candidate.pubkey === wallet.publicKey
  );
  if (!verified) {
    throw forbidden(
      "The source custody wallet must be verified by the acting Private Channels member."
    );
  }

  return { wallet, verified };
}

/**
 * Resolve a caller-supplied counterparty address for a value movement.
 *
 * Accepts a `walletId` or public key of a wallet in the project's custody scope,
 * or a raw Solana address, and rejects the addresses that can only ever strand
 * funds. `requireVerifiedOnInstance` additionally demands that the resolved
 * address be a wallet some member has verified on this instance — which is the
 * right rule for an address CREDITED inside the channel (only a verified wallet
 * can ever spend a channel balance) and the wrong rule for a payout address
 * outside it.
 */
async function resolveCounterpartyAddress(
  c: AppContext,
  context: PrivateChannelActorContext,
  wallets: CustodyWallet[],
  input: {
    value: string;
    fieldName: string;
    requireVerifiedOnInstance: boolean;
  }
): Promise<string> {
  const matched = wallets.find(
    (candidate) => candidate.walletId === input.value || candidate.publicKey === input.value
  );
  const resolved = matched?.publicKey ?? input.value;

  if (!matched && !isAddress(resolved)) {
    throw badRequest(
      `${input.fieldName} must be a \`walletId\` returned by GET /v1/wallets or a valid Solana address, got: ${input.value}`
    );
  }

  if (unsafeAddresses(context.instance).has(resolved)) {
    throw badRequest("System, program, and connected instance addresses cannot be used.");
  }

  if (input.requireVerifiedOnInstance) {
    const verified = await getPrivateChannelVerifiedWalletRepository(c).findAnyByInstanceAndPubkey(
      context.instance.id,
      resolved
    );
    if (!verified) {
      throw badRequest(
        `${input.fieldName} must be a wallet verified on this Private Channels instance; ` +
          "an unverified address could never spend the balance credited to it."
      );
    }
  }

  return resolved;
}

export interface DepositCreateContext extends PrivateChannelActorContext {
  wallet: CustodyWallet;
  /** Channel address credited by the deposit; the depositor when unspecified. */
  recipient: string;
}

/** The single access-policy seam for creating an escrow deposit. */
export async function resolveDepositCreateContext(
  c: AppContext,
  input: { walletId: string; recipient?: string }
): Promise<DepositCreateContext> {
  const context = await resolvePrivateChannelActor(c);
  const wallets = await loadProjectWallets(c, context);
  const { wallet } = await resolveVerifiedSourceWallet(c, context, input.walletId, wallets);

  // The depositor is already verified, so defaulting to it needs no second look.
  const recipient =
    input.recipient === undefined
      ? wallet.publicKey
      : await resolveCounterpartyAddress(c, context, wallets, {
          value: input.recipient,
          fieldName: "recipient",
          requireVerifiedOnInstance: true,
        });

  return { ...context, wallet, recipient };
}

export interface WithdrawalCreateContext extends PrivateChannelActorContext {
  wallet: CustodyWallet;
  /** Address that receives the operator's release; the burn owner when unspecified. */
  destination: string;
}

/**
 * The single access-policy seam for creating a withdrawal.
 *
 * `destination` is deliberately NOT held to instance verification: a withdrawal
 * exists to move value OUT, and the released USDC lands on the instance chain
 * where an unverified address is a legitimate payout target. What makes an
 * arbitrary destination safe is the source check above — the caller can only
 * ever burn a balance they proved control of, so they are redirecting their own
 * money, not someone else's.
 */
export async function resolveWithdrawalCreateContext(
  c: AppContext,
  input: { walletId: string; destination?: string }
): Promise<WithdrawalCreateContext> {
  const context = await resolvePrivateChannelActor(c);
  const wallets = await loadProjectWallets(c, context);
  const { wallet } = await resolveVerifiedSourceWallet(c, context, input.walletId, wallets);

  const destination =
    input.destination === undefined
      ? wallet.publicKey
      : await resolveCounterpartyAddress(c, context, wallets, {
          value: input.destination,
          fieldName: "destination",
          requireVerifiedOnInstance: false,
        });

  return { ...context, wallet, destination };
}
