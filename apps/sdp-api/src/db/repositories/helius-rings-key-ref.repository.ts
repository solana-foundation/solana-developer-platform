import type { KeyKind, MaterialTag } from "@sdp/helius-rings";
import type { RepositoryDbClient } from "./base";

export function generateHeliusRingsKeyRefId(): string {
  return `hrk_${crypto.randomUUID()}`;
}

/**
 * A sealed key blob as stored. `ciphertext` is whatever custody-cipher produced
 * and is never interpreted here — ciphertext in, ciphertext out. This repository
 * must never call `SecretRef.reveal`, and there is deliberately no method that
 * decrypts.
 */
export interface HeliusRingsKeyRefRow {
  id: string;
  wallet_id: string;
  kind: KeyKind;
  ciphertext: string;
  /** Cipher key generation that sealed this blob, for rotation. */
  key_version: string;
  material_tag: MaterialTag;
  /**
   * Material this row replaced during an in-flight re-key. Non-null means a
   * rotation is staged: the wallet's published identity still derives from this
   * blob, not from `ciphertext`, until the new identity reaches the chain.
   */
  previous_ciphertext: string | null;
  previous_key_version: string | null;
  created_at: string;
}

export interface CreateHeliusRingsKeyRefInput {
  walletId: string;
  kind: KeyKind;
  ciphertext: string;
  keyVersion: string;
  materialTag: MaterialTag;
}

export interface HeliusRingsKeyRefRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsKeyRefRepository {
  /**
   * Stores one key blob. A wallet holds at most one key per kind, so a replay of
   * provisioning returns the blob already sealed rather than writing a second
   * one — re-sealing would strand the first and make the identity unreachable.
   */
  createKeyRef(input: CreateHeliusRingsKeyRefInput): Promise<HeliusRingsKeyRefRow | null>;
  getKeyRef(input: { walletId: string; kind: KeyKind }): Promise<HeliusRingsKeyRefRow | null>;
  listKeyRefsByWallet(input: { walletId: string }): Promise<HeliusRingsKeyRefRow[]>;
  /**
   * Stages new material for both kinds at once, moving the blobs they replace
   * into each row's previous slot. Returns the staged rows, or an empty array
   * when the wallet is not in a state that can be staged — no keys yet, or a
   * rotation already staged.
   *
   * One statement rather than two, and all-or-nothing: a wallet's identity comes
   * from the two kinds together, so a process that exited between separate writes
   * would leave keys from different generations and derive an identity nobody
   * published. No application-level guard can cover an exit, so the atomicity has
   * to be the database's.
   *
   * The write-once rule in `createKeyRef` is what makes this a separate method:
   * rotation is the one operation allowed to change sealed material, and it is
   * only safe because the replaced blobs stay reachable until
   * {@link commitKeyRefRotation}.
   */
  stageKeyRefRotation(input: StageHeliusRingsKeyRotationInput): Promise<HeliusRingsKeyRefRow[]>;
  /**
   * Puts back the material a staged rotation replaced, for a re-key that never
   * reached the chain. Returns the restored rows, empty when nothing was staged,
   * so a repeated rollback cannot walk the rows further backwards.
   *
   * One statement for the same reason as staging, and it restores whatever is
   * staged rather than demanding a matched pair, so it is also the repair for a
   * wallet left mid-rotation.
   */
  restoreKeyRefRotation(input: { walletId: string }): Promise<HeliusRingsKeyRefRow[]>;
  /**
   * Drops the staged material for a wallet once its new identity is published.
   *
   * Not merely tidiness: a re-key prompted by a compromised key must not leave
   * those bytes recoverable, and a row that keeps its previous slot reads as
   * mid-rotation forever.
   */
  commitKeyRefRotation(input: { walletId: string }): Promise<number>;
}

export interface StagedHeliusRingsKeyMaterial {
  ciphertext: string;
  keyVersion: string;
}

export interface StageHeliusRingsKeyRotationInput {
  walletId: string;
  viewing: StagedHeliusRingsKeyMaterial;
  nullifier: StagedHeliusRingsKeyMaterial;
}
