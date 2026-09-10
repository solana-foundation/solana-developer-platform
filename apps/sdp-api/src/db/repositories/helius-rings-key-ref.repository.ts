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
   * Stages new material for a re-key, moving the blob it replaces into the row's
   * previous slot. Returns null when the wallet holds no key of that kind, which
   * means there is nothing to rotate and the caller should seal instead.
   *
   * The write-once rule in `createKeyRef` is what makes this a separate method:
   * rotation is the one operation allowed to change sealed material, and it is
   * only safe because the replaced blob stays reachable until
   * {@link commitKeyRefRotation}.
   */
  rotateKeyRef(input: RotateHeliusRingsKeyRefInput): Promise<HeliusRingsKeyRefRow | null>;
  /**
   * Puts back the material a staged rotation replaced, for a re-key that never
   * reached the chain. Returns null when nothing is staged, so a repeated
   * rollback cannot walk the row further backwards.
   */
  restoreKeyRef(input: { walletId: string; kind: KeyKind }): Promise<HeliusRingsKeyRefRow | null>;
  /**
   * Drops the staged material for a wallet once its new identity is published.
   *
   * Not merely tidiness: a re-key prompted by a compromised key must not leave
   * those bytes recoverable, and a row that keeps its previous slot reads as
   * mid-rotation forever.
   */
  commitKeyRefRotation(input: { walletId: string }): Promise<number>;
}

export interface RotateHeliusRingsKeyRefInput {
  walletId: string;
  kind: KeyKind;
  ciphertext: string;
  keyVersion: string;
}
