import { isFireblocksNativeAsset } from "@sdp/custody/providers/fireblocks/native-asset";
import {
  cancelFireblocksTransaction,
  createFireblocksProgramCall,
  type FireblocksTransferResult,
  readFireblocksTransfer,
} from "@sdp/custody/providers/fireblocks/transfers";
import {
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import type { WaistMovement } from "@sdp/types/movements";
import {
  type OperationProposalBinding,
  operationProposalBindingSchema,
} from "@sdp/types/operations";
import {
  address,
  getBase16Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import { badRequest, conflict } from "@/lib/errors";
import { assertMovementAdmitted, type MoneyAdmissionDecision } from "@/lib/money-admission";
import {
  type ProposalAccess,
  ProposalNotSentError,
  proposalRuntime,
  rethrowProposalAdmissionError,
} from "./admitted-proposer";

/** Normalized progress for a sign-only transaction proposal; chain settlement is elsewhere. */
export interface TransactionProposalObservation {
  providerTransactionId: string;
  status: string;
  phase: "pending" | "signed" | "failed" | "cancelled";
  signedTransaction: string | null;
}

/** The Fireblocks response fields needed to verify a signature over the stored message. */
export interface TransactionProposalResult
  extends Pick<FireblocksTransferResult, "id" | "status">,
    Partial<Omit<FireblocksTransferResult, "id" | "status">> {
  signedMessages?: Array<{ signature: { fullSig: string } }>;
}

const fireblocksPort: TransactionProposalPort = {
  propose: (access, request) =>
    createFireblocksProgramCall(proposalRuntime, access, {
      operation: "PROGRAM_CALL",
      externalTxId: request.binding.externalId,
      assetId: request.binding.assetId,
      source: { type: "VAULT_ACCOUNT", id: request.binding.vaultAccountId },
      extraParameters: {
        programCallData: request.unsignedTransaction,
        signOnly: true,
        useDurableNonce: false,
      },
    }),
  read: (access, externalId) => readFireblocksTransfer(proposalRuntime, access, externalId),
  cancel: (access, providerTransactionId) =>
    cancelFireblocksTransaction(proposalRuntime, access, providerTransactionId),
};

/** Provider I/O is injected behind the admission boundary; credentials never leave it. */
export interface TransactionProposalPort {
  propose(
    access: ProposalAccess,
    request: { binding: OperationProposalBinding; unsignedTransaction: string }
  ): Promise<TransactionProposalResult>;
  read(access: ProposalAccess, externalId: string): Promise<TransactionProposalResult | null>;
  cancel(access: ProposalAccess, providerTransactionId: string): Promise<boolean>;
}

/** Provider-neutral transaction proposal capability. It never broadcasts. */
export interface CustodyTransactionProposer {
  readonly provider: "fireblocks";
  readonly address: string;
  prepare(externalId: string): Promise<OperationProposalBinding>;
  propose(request: {
    binding: OperationProposalBinding;
    unsignedTransaction: string;
  }): Promise<TransactionProposalObservation>;
  read(request: {
    binding: OperationProposalBinding;
    unsignedTransaction: string;
  }): Promise<TransactionProposalObservation | null>;
  cancel(binding: OperationProposalBinding): Promise<boolean>;
  admit(binding: OperationProposalBinding): Promise<void>;
}

/** Earn's existing named movements are the only initial consumers of this capability. */
export interface AdmittedTransactionContext {
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  movement: WaistMovement<"earn">;
  address: string;
}

function assertAccount(access: ProposalAccess, binding: OperationProposalBinding): void {
  if (
    access.connectionId !== binding.connectionId ||
    access.accountFingerprint !== binding.accountFingerprint ||
    access.vaultAccountId !== binding.vaultAccountId ||
    access.publicKey !== binding.sourceAddress ||
    !isFireblocksNativeAsset(access.assetId) ||
    !isFireblocksNativeAsset(binding.assetId)
  )
    throw conflict("Custody transaction proposal account changed");
}

function requireOwner(unsignedTransaction: string, sourceAddress: string) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(unsignedTransaction)
  );
  if (transaction.signatures[address(sourceAddress)] === undefined)
    throw badRequest("Prepared transaction does not require its custody owner to sign");
  return transaction;
}

async function observe(
  result: TransactionProposalResult,
  binding: OperationProposalBinding,
  unsignedTransaction: string,
  detailed: boolean
): Promise<TransactionProposalObservation> {
  if (
    detailed &&
    (result.externalTxId !== binding.externalId ||
      result.operation !== "PROGRAM_CALL" ||
      result.assetId !== binding.assetId ||
      result.source?.type !== "VAULT_ACCOUNT" ||
      result.source.id !== binding.vaultAccountId)
  )
    throw conflict("Provider proposal does not match its recorded transaction identity");
  if (result.txHash !== undefined && result.txHash !== "")
    throw conflict("Sign-only custody proposal unexpectedly attempted broadcast");
  if (result.status === "SIGNED") {
    if (result.signedMessages?.length !== 1)
      throw conflict("Provider did not return exactly one Solana signature");
    const message = result.signedMessages[0];
    if (message === undefined) throw conflict("Provider signature is missing");
    const transaction = requireOwner(unsignedTransaction, binding.sourceAddress);
    const signature = signatureBytes(getBase16Encoder().encode(message.signature.fullSig));
    const owner = address(binding.sourceAddress);
    if (
      !(await verifySignature(
        await getPublicKeyFromAddress(owner),
        signature,
        transaction.messageBytes
      ))
    )
      throw conflict("Provider signature does not sign the prepared transaction");
    return {
      providerTransactionId: result.id,
      status: result.status,
      phase: "signed",
      signedTransaction: getBase64EncodedWireTransaction({
        ...transaction,
        signatures: { ...transaction.signatures, [owner]: signature },
      }),
    };
  }
  return {
    providerTransactionId: result.id,
    status: result.status,
    phase: unsignedProposalPhase(result.status),
    signedTransaction: null,
  };
}

/**
 * Where an unsigned Fireblocks proposal stands. Fireblocks' status set is open, so any status
 * it adds stays pending: an unrecognized one never ends or broadcasts the operation.
 */
function unsignedProposalPhase(
  status: string
): Exclude<TransactionProposalObservation["phase"], "signed"> {
  switch (status) {
    case "BROADCASTING":
    case "CONFIRMING":
    case "COMPLETED":
      throw conflict("Sign-only custody proposal unexpectedly attempted broadcast");
    default:
      if (isFireblocksTransactionCancelled(status)) return "cancelled";
      return isFireblocksTransactionFailed(status) ? "failed" : "pending";
  }
}

/**
 * Admit a fresh Earn proposal through the existing custody boundary. Recovery
 * may read/cancel its original account after runtime availability is withdrawn;
 * preparing/proposing and resuming signing still require fresh live admission.
 */
export function admittedTransactionProposer(
  access: {
    prepare: () => Promise<ProposalAccess>;
    live: () => Promise<ProposalAccess>;
    recovery: (binding: OperationProposalBinding) => Promise<ProposalAccess>;
  },
  decide: () => Promise<MoneyAdmissionDecision>,
  context: AdmittedTransactionContext,
  port: TransactionProposalPort = fireblocksPort
): CustodyTransactionProposer {
  const admit = async (binding: OperationProposalBinding): Promise<ProposalAccess> => {
    try {
      const decision = await decide();
      assertMovementAdmitted(decision, {
        surface: "signer",
        movement: context.movement,
        organizationId: context.organizationId,
        projectId: context.projectId,
        subjectId: context.custodyWalletId,
      });
      const live = await access.live();
      assertAccount(live, operationProposalBindingSchema.parse(binding));
      if (live.publicKey !== context.address) throw conflict("Custody source wallet changed");
      return live;
    } catch (error) {
      rethrowProposalAdmissionError(error);
    }
  };
  return {
    provider: "fireblocks",
    address: context.address,
    async prepare(externalId) {
      const current = await access.prepare();
      if (current.publicKey !== context.address) throw conflict("Custody source wallet changed");
      const binding = operationProposalBindingSchema.parse({
        provider: "fireblocks",
        externalId,
        connectionId: current.connectionId,
        accountFingerprint: current.accountFingerprint,
        vaultAccountId: current.vaultAccountId,
        assetId: current.assetId,
        sourceAddress: current.publicKey,
      });
      assertAccount(current, binding);
      return binding;
    },
    async propose(request) {
      let live: ProposalAccess;
      try {
        live = await admit(request.binding);
        requireOwner(request.unsignedTransaction, request.binding.sourceAddress);
      } catch (cause) {
        throw new ProposalNotSentError(cause);
      }
      return observe(
        await port.propose(live, request),
        request.binding,
        request.unsignedTransaction,
        false
      );
    },
    async read(request) {
      const current = await access.recovery(request.binding);
      assertAccount(current, request.binding);
      const result = await port.read(current, request.binding.externalId);
      return result === null
        ? null
        : observe(result, request.binding, request.unsignedTransaction, true);
    },
    async cancel(binding) {
      const current = await access.recovery(binding);
      assertAccount(current, binding);
      const result = await port.read(current, binding.externalId);
      if (result === null) return false;
      if (
        result.externalTxId !== binding.externalId ||
        result.operation !== "PROGRAM_CALL" ||
        result.assetId !== binding.assetId ||
        result.source?.id !== binding.vaultAccountId ||
        result.source.type !== "VAULT_ACCOUNT"
      )
        throw conflict("Provider cancellation target does not match the recorded proposal");
      if (!isFireblocksTransactionCancellable(result.status)) return false;
      return port.cancel(current, result.id);
    },
    async admit(binding) {
      await admit(binding);
    },
  };
}
