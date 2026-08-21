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
}
