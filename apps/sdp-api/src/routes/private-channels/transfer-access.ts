import type { PrivateChannelInstance, PrivateChannelTransferRecipientDto } from "@sdp/types";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { mapPrivateChannelInstanceRow, type PrivateChannelUserRow } from "@/db/repositories";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, forbidden, notFound, providerUnavailable, walletNotFound } from "@/lib/errors";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSigner } from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";
import {
  getPrivateChannelRepository,
  getPrivateChannelTransferRepository,
  getPrivateChannelUserRepository,
  getPrivateChannelVerifiedWalletRepository,
} from "./context";
import { requireActiveInstance } from "./helpers";

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: This is the public Solana Memo program address.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

interface TransferActorContext {
  auth: ApiKeyContext;
  projectId: string;
  instance: PrivateChannelInstance;
  actor: PrivateChannelUserRow;
  recipients: PrivateChannelTransferRecipientDto[];
}

export interface TransferCreateContext extends TransferActorContext {
  wallet: CustodyWallet;
  recipient: {
    privateChannelUserId: string;
    verifiedWalletId: string;
    pubkey: string;
  };
  /**
   * Resolved here and handed to the service so a transfer derives its signer once.
   * This is also the stricter check of the two: it holds the signer against BOTH
   * the custody wallet and the member's verified pubkey.
   */
  signer: Awaited<ReturnType<typeof createOrgSigner>>;
}

/**
 * Program, system and connected-instance addresses, which must never be an endpoint
 * of a member transfer.
 *
 * Reaching one should be impossible: both sides of a transfer must be a wallet that
 * passed challenge-signature verification, and none of these addresses has a private
 * key — the program ids are fixed accounts and the escrow instance is a PDA. This is
 * kept as a cheap invariant on the money path rather than a filter, so a change to
 * how wallets become verified fails loudly instead of silently allowing one.
 */
function unsafeAddresses(instance: PrivateChannelInstance): ReadonlySet<string> {
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

async function resolveTransferActor(
  c: AppContext,
  channelId: string
): Promise<TransferActorContext> {
  const auth = getAuth(c);
  if (!auth.userId) {
    throw forbidden(
      "Private Channel transfers require a user identity and are not available for API-key auth."
    );
  }

  const projectId = requireProjectId(c);
  const instanceRow = await requireActiveInstance(c);
  const channel = await getPrivateChannelRepository(c).getChannel({
    channelId,
    instanceId: instanceRow.id,
  });
  if (!channel) {
    throw notFound("Active private channel");
  }

  const scope = { organizationId: auth.organizationId, projectId };
  const userRepository = getPrivateChannelUserRepository(c);
  const actor = await userRepository.findByProjectAndUser(scope, auth.userId);
  if (!actor) {
    throw forbidden("You must be a Private Channels member to transfer funds.");
  }

  const memberships = await userRepository.listMembershipsForUser(actor.id);
  const membership = memberships.find((item) => item.channel_id === channel.id);
  if (!membership) {
    throw forbidden("You must be a member of this channel to transfer funds.");
  }

  const instance = mapPrivateChannelInstanceRow(instanceRow);
  const recipients = await getPrivateChannelTransferRepository(c).listEligibleRecipients({
    ...scope,
    instanceId: instance.id,
    channelId: channel.id,
    initiatingPrivateChannelUserId: actor.id,
  });
  return { auth, projectId, instance, actor, recipients };
}

/** The single access-policy seam for transfer recipient discovery. */
export async function resolveTransferRecipients(
  c: AppContext,
  channelId: string
): Promise<PrivateChannelTransferRecipientDto[]> {
  const context = await resolveTransferActor(c, channelId);
  return context.recipients;
}

/** The single access-policy seam for creating a channel transfer. */
export async function resolveTransferCreateContext(
  c: AppContext,
  input: {
    channelId: string;
    walletId: string;
    recipientVerifiedWalletId: string;
  }
): Promise<TransferCreateContext> {
  const context = await resolveTransferActor(c, input.channelId);
  const wallets = await createSigningService(c.env).getWalletsWithProviders(
    context.auth.organizationId,
    context.projectId,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((candidate) => candidate.walletId === input.walletId);
  if (!wallet) {
    throw walletNotFound();
  }

  const verifiedWallets = await getPrivateChannelVerifiedWalletRepository(c).listByUserAndInstance(
    context.actor.id,
    context.instance.id
  );
  const verifiedSource = verifiedWallets.find(
    (verified) => verified.wallet_id === wallet.walletId && verified.pubkey === wallet.publicKey
  );
  if (!verifiedSource) {
    throw forbidden(
      "The source custody wallet must be verified by the acting Private Channels member."
    );
  }

  let recipient:
    | {
        privateChannelUserId: string;
        verifiedWalletId: string;
        pubkey: string;
      }
    | undefined;
  for (const candidate of context.recipients) {
    const verifiedWallet = candidate.wallets.find(
      (entry) => entry.id === input.recipientVerifiedWalletId
    );
    if (verifiedWallet) {
      recipient = {
        privateChannelUserId: candidate.privateChannelUserId,
        verifiedWalletId: verifiedWallet.id,
        pubkey: verifiedWallet.pubkey,
      };
      break;
    }
  }
  if (!recipient) {
    throw notFound("Eligible transfer recipient");
  }

  if (wallet.publicKey === recipient.pubkey) {
    throw badRequest("Sender and recipient must be different verified wallets.");
  }
  const unsafe = unsafeAddresses(context.instance);
  if (unsafe.has(wallet.publicKey) || unsafe.has(recipient.pubkey)) {
    throw badRequest("System, program, and connected instance addresses cannot be used.");
  }

  let signer: Awaited<ReturnType<typeof createOrgSigner>>;
  try {
    signer = await createOrgSigner(
      c.env,
      context.auth.organizationId,
      context.projectId,
      wallet.walletId
    );
  } catch {
    throw providerUnavailable("The source custody wallet is not currently signable.");
  }
  if (signer.address !== wallet.publicKey || signer.address !== verifiedSource.pubkey) {
    throw badRequest("Resolved signer does not match the verified source custody wallet.");
  }

  return { ...context, wallet, recipient, signer };
}
