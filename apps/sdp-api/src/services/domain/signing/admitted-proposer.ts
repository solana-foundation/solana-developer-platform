import {
  type FireblocksAddressEntry,
  readFireblocksAddressBook,
} from "@sdp/custody/provisioning/fireblocks-address-book";
import {
  createFireblocksTransfer,
  type FireblocksTransferAccess,
  type FireblocksTransferResult,
  readFireblocksTransfer,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/provisioning/fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { currentClusterScope } from "@sdp/rpc/scope";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { isFireblocksPaymentMint } from "@sdp/types/fireblocks";
import type { MovementId } from "@sdp/types/movements";
import { z } from "zod";
import { badRequest, conflict, serviceUnavailable } from "@/lib/errors";
import { assertMovementAdmitted, type MoneyAdmissionDecision } from "@/lib/money-admission";

/**
 * What a provider-built transfer is bound to when SDP records it: the exact Connection, provider
 * account, vault and provider asset. Every later step (the proposal, each status read) checks the
 * live Connection against it, so a rotated or re-pointed credential can never move or settle a
 * payment it did not prepare.
 */
export const transferProposalIntentSchema = z.object({
  connectionId: z.string(),
  accountFingerprint: z.string(),
  vaultAccountId: z.string(),
  assetId: z.string(),
});
export type TransferProposalIntent = z.infer<typeof transferProposalIntentSchema>;

/** The provider credential and the exact wallet it serves, read fresh inside the waist. */
export interface ProposalAccess extends FireblocksTransferAccess {
  vaultAccountId: string;
  publicKey: string;
  connectionId: string;
  accountFingerprint: string;
  assetId: string;
}

export interface TransferProposalRequest {
  /** The SDP transfer id; Fireblocks keeps it as the permanent `externalTxId`. */
  externalId: string;
  intent: TransferProposalIntent;
  sourceAddress: string;
  destination: string;
  amount: string;
  memo: string | null;
}

/**
 * Thrown when a proposal was refused before anything reached the provider: admission, a changed
 * Connection, or an invalid intent. Only this error proves the payment is unsent; any other
 * failure from {@link CustodyTransferProposer.propose} may follow acceptance.
 */
export class ProposalNotSentError extends Error {
  constructor(readonly refusal: unknown) {
    super("Custody proposal was refused before submission", { cause: refusal });
    this.name = "ProposalNotSentError";
  }
}

/**
 * The custody waist's other half (ADR 0007, PRO-2435 D2). A wallet whose provider builds, signs
 * and broadcasts its own transfers (Fireblocks BYOK today) is resolved here instead of as a
 * `TransactionSigner`, through the same prelude: exact wallet row, runtime availability, wallet
 * purpose and provider entitlement. Proposing decides admission again, from live rows, exactly
 * as each signature does.
 */
export interface CustodyTransferProposer {
  readonly provider: "fireblocks";
  readonly address: string;
  /** Validates network, token and amount against the provider and binds the intent. Sends nothing. */
  prepare(operation: { token: string; amount: string; native: boolean }): Promise<{
    intent: TransferProposalIntent;
  }>;
  /** Admits, re-checks the binding, then creates the provider transfer once. */
  propose(request: TransferProposalRequest): Promise<FireblocksTransferResult>;
  /**
   * Pay's destination advisory: whether the provider would already accept this exact address for
   * this token (its whitelist), read-only. It shares `prepare`'s network, token and asset rules,
   * so the warning and the payment can never disagree about which asset is meant.
   */
  checkDestination(destination: { token: string; native: boolean; address: string }): Promise<{
    state: DestinationState;
    assetId: string;
  }>;
}

/** Whether the provider's address book already allows a destination for an asset. */
export type DestinationState = "approved" | "pending" | "not_whitelisted";

/**
 * Approved and active wins; an approved entry still in its activation delay, or one waiting for
 * approval, is pending; anything else (no entry, rejected) is not whitelisted.
 */
export function destinationState(
  entries: FireblocksAddressEntry[],
  assetId: string,
  address: string,
  now = Date.now()
): DestinationState {
  const matches = entries.filter((entry) => entry.assetId === assetId && entry.address === address);
  const approved = matches.filter((entry) => entry.status === "APPROVED");
  if (
    approved.some(
      (entry) =>
        !entry.activationTime ||
        (Number.isFinite(Date.parse(entry.activationTime)) &&
          Date.parse(entry.activationTime) <= now)
    )
  )
    return "approved";
  if (approved.length || matches.some((entry) => entry.status === "WAITING_FOR_APPROVAL"))
    return "pending";
  return "not_whitelisted";
}

/** Read-only recovery for a recorded proposal. It can never create or resubmit a transfer. */
export interface CustodyProposalReader {
  read(externalId: string): Promise<FireblocksTransferResult | null>;
}

export const proposalRuntime: CustodyProvisioningRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (data) => crypto.getRandomValues(new Uint8Array(data)),
  sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
};

function expectedNetworkAsset(): "SOL" | "SOL_TEST" {
  return currentClusterScope().cluster === "mainnet-beta" ? "SOL" : "SOL_TEST";
}

function assertBoundTo(access: ProposalAccess, intent: TransferProposalIntent, source: string) {
  if (
    access.connectionId !== intent.connectionId ||
    access.accountFingerprint !== intent.accountFingerprint ||
    access.vaultAccountId !== intent.vaultAccountId ||
    access.publicKey !== source ||
    access.assetId !== expectedNetworkAsset()
  )
    throw conflict("Fireblocks connection does not match the payment intent");
}

/**
 * The one rule for which provider asset a payment uses: the Connection must serve the current
 * network, the token must be SOL or the network's canonical USDC, and the asset is found by its
 * exact mint, never by symbol. Shared by preparing a payment and by Pay's destination advisory.
 */
async function resolvePaymentAsset(
  access: ProposalAccess,
  operation: { token: string; native: boolean },
  runtime: CustodyProvisioningRuntime
) {
  const network = currentClusterScope().cluster;
  if (access.assetId !== expectedNetworkAsset())
    throw badRequest("Fireblocks connection does not match the Solana network");
  if (!operation.native && !isFireblocksPaymentMint(operation.token, network))
    throw badRequest("Fireblocks payments currently support SOL and USDC only");
  return resolveFireblocksTransferAsset(
    runtime,
    access,
    expectedNetworkAsset(),
    operation.native ? null : operation.token
  );
}

export interface AdmittedProposerContext {
  movement: MovementId;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  address: string;
}

/**
 * Wraps provider-built transfers with the waist's admission, as `admittedSigner` wraps signatures.
 *
 * @param loadAccess - Reads the Connection's credential inside the waist, never cached: `prepare`
 *   from the row resolved for this request, `propose` from the wallet row re-read at that moment.
 * @param decide - The same live admission decision a signature runs.
 * @param context - The movement and exact wallet, for refusal events.
 */
export function admittedTransferProposer(
  loadAccess: {
    prepare: () => Promise<ProposalAccess>;
    propose: () => Promise<ProposalAccess>;
  },
  decide: () => Promise<MoneyAdmissionDecision>,
  context: AdmittedProposerContext,
  runtime: CustodyProvisioningRuntime = proposalRuntime
): CustodyTransferProposer {
  return {
    provider: "fireblocks",
    address: context.address,
    async prepare(operation) {
      const access = await loadAccess.prepare();
      if (access.publicKey !== context.address) throw conflict("Fireblocks source wallet changed");
      const asset = await resolvePaymentAsset(access, operation, runtime);
      let units: bigint;
      try {
        units = parseDecimalAmount(operation.amount, asset.decimals);
      } catch {
        throw badRequest(`Payment amount must have at most ${asset.decimals} decimal places`);
      }
      if (units <= 0n || units > 18446744073709551615n)
        throw badRequest("Payment amount is outside the supported range");
      return {
        intent: {
          connectionId: access.connectionId,
          accountFingerprint: access.accountFingerprint,
          vaultAccountId: access.vaultAccountId,
          assetId: asset.id,
        },
      };
    },
    async checkDestination(destination) {
      const access = await loadAccess.prepare();
      const asset = await resolvePaymentAsset(access, destination, runtime);
      let entries: FireblocksAddressEntry[];
      try {
        entries = await readFireblocksAddressBook(runtime, access);
      } catch {
        throw serviceUnavailable("Couldn’t check the Fireblocks address book. Try again later.");
      }
      return { state: destinationState(entries, asset.id, destination.address), assetId: asset.id };
    },
    async propose(request) {
      let access: ProposalAccess;
      try {
        // Both reads are by primary key and independent, so they run together. The credential is
        // read fresh: nothing captured at prepare time is ever submitted.
        const [decision, live] = await Promise.all([decide(), loadAccess.propose()]);
        assertMovementAdmitted(decision, {
          surface: "signer",
          movement: context.movement,
          organizationId: context.organizationId,
          projectId: context.projectId,
          subjectId: context.custodyWalletId,
        });
        assertBoundTo(live, request.intent, request.sourceAddress);
        access = live;
      } catch (error) {
        throw new ProposalNotSentError(error);
      }
      return createFireblocksTransfer(runtime, access, {
        operation: "TRANSFER",
        externalTxId: request.externalId,
        assetId: request.intent.assetId,
        source: { type: "VAULT_ACCOUNT", id: request.intent.vaultAccountId },
        destination: {
          type: "ONE_TIME_ADDRESS",
          oneTimeAddress: { address: request.destination },
        },
        amount: request.amount,
        treatAsGrossAmount: false,
        // SDP's memo is a payment note, not an instruction added to the chain.
        note: `SDP ${request.externalId}${request.memo ? `: ${request.memo}` : ""}`,
      });
    },
  };
}

/** Status reads for a recorded proposal, bound to the access the waist resolved for its intent. */
export function proposalReader(
  loadAccess: () => Promise<ProposalAccess>,
  runtime: CustodyProvisioningRuntime = proposalRuntime
): CustodyProposalReader {
  return {
    async read(externalId) {
      return readFireblocksTransfer(runtime, await loadAccess(), externalId);
    },
  };
}
