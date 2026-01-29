/**
 * Fireblocks utility helpers
 *
 * Provides encoding/decoding utilities for Fireblocks data formats.
 */

import { type Address, isAddress } from "@solana/addresses";
import { getBase58Codec } from "@solana/codecs";

const base58 = getBase58Codec();

function isHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Decode base64/base64url to bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decode hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Encode bytes to base58 string
 */
export function encodeBase58(bytes: Uint8Array): string {
  return base58.decode(bytes) as string;
}

/**
 * Decode base58 string to bytes
 */
export function decodeBase58(value: string): Uint8Array {
  return new Uint8Array(base58.encode(value));
}

/**
 * Normalize a public key from various formats to Solana Address
 *
 * Fireblocks may return public keys as:
 * - Base58 string (already a valid address)
 * - Hex string (32 bytes = 64 hex chars)
 * - Base64 string
 */
export function normalizePublicKey(value: string): Address {
  if (isAddress(value)) {
    return value;
  }

  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (isHex(normalized) && normalized.length === 64) {
    return encodeBase58(hexToBytes(normalized)) as Address;
  }

  try {
    return encodeBase58(base64ToBytes(value)) as Address;
  } catch {
    throw new Error("Unsupported public key format returned by Fireblocks");
  }
}

function tryDecodeBase64(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

function tryDecodeBase58(value: string): Uint8Array | null {
  try {
    return decodeBase58(value);
  } catch {
    return null;
  }
}

/**
 * Normalize a signature from Fireblocks response to bytes
 *
 * Fireblocks signatures can be in various formats:
 * - Hex string
 * - Base64 string
 * - Object with fullSig or signature property
 */
export function normalizeSignatureToBytes(value: unknown): Uint8Array | null {
  if (!value) {
    return null;
  }

  const raw =
    typeof value === "string"
      ? value
      : typeof value === "object" && value
        ? typeof (value as { fullSig?: string }).fullSig === "string"
          ? (value as { fullSig: string }).fullSig
          : typeof (value as { signature?: string }).signature === "string"
            ? (value as { signature: string }).signature
            : null
        : null;

  if (!raw) {
    return null;
  }

  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (isHex(normalized)) {
    return hexToBytes(normalized);
  }

  const base64Bytes = tryDecodeBase64(raw);
  if (base64Bytes) {
    return base64Bytes;
  }

  const base58Bytes = tryDecodeBase58(raw);
  if (base58Bytes) {
    return base58Bytes;
  }

  return null;
}

/**
 * Normalize a signature from Fireblocks response to base58 string
 */
export function normalizeSignature(value: unknown): string | null {
  const bytes = normalizeSignatureToBytes(value);
  return bytes ? encodeBase58(bytes) : null;
}
