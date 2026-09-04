import type { Address, Bytes32 } from "@heliuslabs/zolana";
import { randomSalt } from "@heliuslabs/zolana/keypair";
import type { ProofOutputUtxo } from "@heliuslabs/zolana/transaction";
import {
  type AssetRegistry,
  encodeConfidentialSlots,
  LocalWalletAuthority,
} from "@heliuslabs/zolana/transaction";
import type {
  ApprovalRequest,
  EncryptedCustomRingTransfer,
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
 * Audit context for the decision this authority was constructed under.
 *
 * Only `owner` participates in `requestUserApproval`; the other two correlate
 * logs and persisted state and do not bind what Zolana builds. Enforcement
 * comes from prepared-intent and final-wire validation instead.
 */
export interface OperationAuthorization {
  /** Base58 address of the owner SDP approved spending for. */
  readonly owner: string;
  /** Correlates this authority instance with an SDP operation row for audit. */
  readonly operationId: string;
  /** The persisted intent key for audit correlation, not semantic enforcement. */
  readonly intentKey: string;
}

export interface CustodyWalletAuthorityInput {
  readonly material: ShieldedMaterial;
  readonly authorization: OperationAuthorization;
}

/**
 * A `WalletAuthority` whose Solana owner and shielded keys come from different
 * places: the owner's Ed25519 secret stays in SDP custody and signs the outer
 * transaction, while viewing and nullifier keys arrive as material.
 *
 * The SDK's `LocalWalletAuthority` accepts the same three-key material, but
 * this authority additionally carries SDP's audit context, refuses the flows
 * this integration never reviewed, and destroys the transaction viewing key
 * after a confidential encryption. Nothing on the spend path needs a shielded
 * signature: ownership enters the proof as `ownerProofInputHash`, and
 * authorization is the owner's signature on the Solana transaction.
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

  /** Operation-row audit context carried by this authority. */
  operationId(): string {
    return this.#authorization.operationId;
  }

  /** Persisted intent-key audit context carried by this authority. */
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

  /**
   * Delegated to the SDK's own implementation over this material's three keys:
   * the ring obligations (the auditor-sealed viewing secret and the audit
   * witness the ring's second proof consumes) need only viewing-key material,
   * so the Ed25519 custody split is not crossed. Key lifetimes are the SDK's
   * contract: `proveCustomRingTransfer` zeroes the audit secrets in its own
   * `finally`.
   */
  encryptCustomRingTransfer(
    input: Parameters<WalletAuthority["encryptCustomRingTransfer"]>[0]
  ): Promise<EncryptedCustomRingTransfer> {
    return new LocalWalletAuthority({
      solanaPublicKey: this.#owner,
      address: this.#material.shieldedAddress,
      viewingKey: this.#material.viewingKey,
      nullifierKey: this.#material.nullifierKey,
    }).encryptCustomRingTransfer(input);
  }

  encryptSplit(_input: Parameters<WalletAuthority["encryptSplit"]>[0]): Promise<EncryptedSplit> {
    return Promise.reject(new RingsUnsupportedFlowError("split"));
  }

  /**
   * High-level builders may call this rather than prompting after SDP already
   * collected approval. The low-level spend rail used by this integration
   * bypasses it, so this owner check is defense in depth, not the intent gate.
   */
  requestUserApproval(request: ApprovalRequest): Promise<void> {
    if (request.solanaPublicKey !== this.#owner) {
      return Promise.reject(new RingsApprovalMismatchError(this.#owner, request.solanaPublicKey));
    }

    this.#approvals.push(request.summary);
    return Promise.resolve();
  }
}
