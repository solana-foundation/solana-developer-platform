/**
 * Fireblocks utility helpers
 */

import { type Address, isAddress } from "@solana/addresses";
import { getBase58Codec } from "@solana/codecs";

const base58 = getBase58Codec();

function isHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

/** Convert bytes to base58 string */
function encodeBase58(bytes: Uint8Array): string {
  // codec.decode converts bytes → string representation
  return base58.decode(bytes) as string;
}

/** Convert base58 string to bytes */
function decodeBase58(value: string): Uint8Array {
  // codec.encode converts string → bytes representation
  return new Uint8Array(base58.encode(value));
}

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

export function normalizeSignature(value: unknown): string | null {
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
    return encodeBase58(hexToBytes(normalized));
  }

  const base64Bytes = tryDecodeBase64(raw);
  if (base64Bytes) {
    return encodeBase58(base64Bytes);
  }

  const base58Bytes = tryDecodeBase58(raw);
  if (base58Bytes) {
    return encodeBase58(base58Bytes);
  }

  return null;
}
