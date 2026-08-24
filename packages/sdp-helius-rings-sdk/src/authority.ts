import type { Address, Bytes32 } from "@heliuslabs/zolana";
import { randomSalt } from "@heliuslabs/zolana/keypair";
import type { ProofOutputUtxo } from "@heliuslabs/zolana/transaction";
import { type AssetRegistry, encodeConfidentialSlots } from "@heliuslabs/zolana/transaction";
import type {
  ApprovalRequest,
  EncryptedSplit,
  EncryptedTransfer,
  WalletAuthority,
  WalletSyncMaterial,
} from "@heliuslabs/zolana/wallet";
import { address } from "@solana/kit";
import type { ShieldedMaterial } from "./material.js";

/**
 * A flow this integration deliberately does not support. Thrown rather than
 * approximated: an anonymous transfer built by a path that was never reviewed
 * discloses the wrong thing to the wrong party.
 */
export class RingsUnsupportedFlowError extends Error {
  readonly flow: string;

  constructor(flow: string) {
    super(`Rings flow ${flow} is not supported by this integration.`);
    this.name = "RingsUnsupportedFlowError";
    this.flow = flow;
  }
}

/** Raised when a builder asks to spend under an owner that was not approved. */
export class RingsApprovalMismatchError extends Error {
  constructor(expected: Address, requested: Address) {
    super(`Rings builder requested approval for ${requested}, but ${expected} was authorized.`);
    // biome-ignore lint/security/noSecrets: error class name, not a secret.
    this.name = "RingsApprovalMismatchError";
  }
}

/**
 * The decision this authority was constructed against. SDP resolves policy and
 * approval before any builder runs, so `requestUserApproval` verifies that the
 * transaction being built is the one that was authorized instead of prompting.
 */
export interface OperationAuthorization {
  /** Base58 address of the owner SDP approved spending for. */
  readonly owner: string;
  /** Correlates an approval callback with an SDP operation row. */
  readonly operationId: string;
  /**
   * The approved operation's `intent_key`. Required so an authority cannot be
   * constructed without naming the approval it stands for. It is not checked
   * inside `requestUserApproval`, because the SDK's `ApprovalRequest` carries
   * only an owner and a summary; the caller compares it against the persisted
   * operation, and the built transaction is validated structurally.
   */
  readonly intentKey: string;
}

export interface CustodyWalletAuthorityInput {
  readonly material: ShieldedMaterial;
  readonly authorization: OperationAuthorization;
}

/**
 * A `WalletAuthority` whose Solana owner and shielded keys come from different
 * places: the owner's Ed25519 secret stays in SDP custody and signs the outer
 * transaction, while the viewing and nullifier keys arrive as material from a
 * `ShieldedMaterialSource`.
 *
 * The SDK's `LocalWalletAuthority` cannot express that split because every
 * `ShieldedKeypair` constructor expands both role keys from a signing secret.
 * Nothing on the spend path needs a shielded signature though: ownership enters
 * the proof as `ownerProofInputHash`, and authorization is the owner's
 * signature on the Solana transaction.
 */
export class CustodyWalletAuthority implements WalletAuthority {
  readonly #material: ShieldedMaterial;
  readonly #authorization: OperationAuthorization;
  readonly #owner: Address;
  readonly #approvals: string[] = [];

  constructor(input: CustodyWalletAuthorityInput) {
    if (input.authorization.operationId.length === 0) {
      throw new Error("A Rings authority needs the operation it was authorized for.");
    }
    if (input.authorization.intentKey.length === 0) {
      throw new Error("A Rings authority needs the approved intent key.");
    }

    this.#material = input.material;
    this.#authorization = input.authorization;
    this.#owner = address(input.authorization.owner);
  }

  /** Summaries the SDK asked approval for, in call order. */
  approvedSummaries(): readonly string[] {
    return [...this.#approvals];
  }

  /** The SDP operation this authority was authorized for. */
  operationId(): string {
    return this.#authorization.operationId;
  }

  /** The approved intent this authority stands for. */
  intentKey(): string {
    return this.#authorization.intentKey;
  }

  solanaPublicKey(): Address {
    return this.#owner;
  }

  shieldedAddress() {
    return Promise.resolve(this.#material.shieldedAddress);
  }

  viewingKeys() {
    return Promise.resolve([this.#material.viewingKey]);
  }

  spendNullifierKey() {
    return Promise.resolve(this.#material.nullifierKey);
  }

  syncMaterial(): Promise<WalletSyncMaterial> {
    return Promise.resolve({
      identity: this.#material.shieldedAddress,
      viewingKeys: [this.#material.viewingKey],
      nullifierKey: this.#material.nullifierKey,
    });
  }

  encryptConfidentialTransfer(
    input: Readonly<{
      firstNullifier: Bytes32;
      outputs: readonly ProofOutputUtxo[];
      assets: AssetRegistry;
    }>
  ): Promise<EncryptedTransfer> {
    const transactionViewingKey = this.#material.viewingKey.transactionViewingKey(
      input.firstNullifier
    );
    const salt = randomSalt();

    try {
      return Promise.resolve({
        txViewingPublicKey: transactionViewingKey.publicKey(),
        salt,
        payload: encodeConfidentialSlots(input.outputs, input.assets, transactionViewingKey, salt),
      });
    } finally {
      transactionViewingKey.destroy();
    }
  }

  encryptAnonymousTransfer(
    _input: Parameters<WalletAuthority["encryptAnonymousTransfer"]>[0]
  ): Promise<EncryptedTransfer> {
    return Promise.reject(new RingsUnsupportedFlowError("transfer_anonymous"));
  }

  encryptSplit(_input: Parameters<WalletAuthority["encryptSplit"]>[0]): Promise<EncryptedSplit> {
    return Promise.reject(new RingsUnsupportedFlowError("split"));
  }

  /**
   * Builders call this for every private operation, so it must resolve for an
   * authorized request. It verifies rather than prompts: SDP already collected
   * the approval, and the check that matters is that the builder is spending
   * under the owner that approval covered.
   */
  requestUserApproval(request: ApprovalRequest): Promise<void> {
    if (request.solanaPublicKey !== this.#owner) {
      return Promise.reject(new RingsApprovalMismatchError(this.#owner, request.solanaPublicKey));
    }

    this.#approvals.push(request.summary);
    return Promise.resolve();
  }
}
