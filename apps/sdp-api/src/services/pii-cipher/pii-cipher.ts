import { GcpMetadataTokenProvider } from "@/lib/gcp/access-token";
import { KmsClient } from "@/lib/gcp/kms-client";
import { getDeploymentMode } from "@/lib/runtime-env";
import type { Env } from "@/types/env";

const KMS_PREFIX = "pii-v1.";
const LOCAL_PREFIX = "pii-local-v1.";
const IV_LENGTH = 12;
const LOCAL_SALT = new TextEncoder().encode("sdp-counterparty-pii-local-v1");

export type PiiResourceType = "counterparty" | "counterparty_account";
export type PiiField = "identity" | "provider_data" | "account_data";

export interface PiiCipherContext {
  organizationId: string;
  projectId: string;
  resourceType: PiiResourceType;
  resourceId: string;
  field: PiiField;
}

export interface PiiCipher {
  encrypt(context: PiiCipherContext, plaintext: string): Promise<string>;
  decrypt(context: PiiCipherContext, ciphertext: string): Promise<string>;
}

export interface PiiEnvelopeKms {
  encrypt(plaintext: Uint8Array, aad: string): Promise<string>;
  decrypt(ciphertext: string, aad: string): Promise<Uint8Array>;
}

export class PiiCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiCipherError";
  }
}

function canonicalAad(context: PiiCipherContext): string {
  return JSON.stringify([
    "sdp-counterparty-pii-v1",
    context.organizationId,
    context.projectId,
    context.resourceType,
    context.resourceId,
    context.field,
  ]);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new PiiCipherError("Malformed PII ciphertext encoding");
  }
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptAesGcm(key: CryptoKey, plaintext: string, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  return blob;
}

async function decryptAesGcm(key: CryptoKey, blob: Uint8Array, aad: string): Promise<string> {
  if (blob.length < IV_LENGTH + 16) {
    throw new PiiCipherError("PII ciphertext is too short");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.slice(0, IV_LENGTH),
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      blob.slice(IV_LENGTH)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new PiiCipherError("PII ciphertext authentication failed");
  }
}

export class KmsPiiCipher implements PiiCipher {
  constructor(private readonly kms: PiiEnvelopeKms) {}

  async encrypt(context: PiiCipherContext, plaintext: string): Promise<string> {
    const aad = canonicalAad(context);
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = await encryptAesGcm(await importAesKey(dek), plaintext, aad);
    const wrappedDek = await this.kms.encrypt(dek, aad);
    return `${KMS_PREFIX}${wrappedDek}.${b64url(encrypted)}`;
  }

  async decrypt(context: PiiCipherContext, ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith(KMS_PREFIX)) {
      throw new PiiCipherError("Ciphertext is not a PII KMS envelope");
    }
    const payload = ciphertext.slice(KMS_PREFIX.length);
    const separator = payload.indexOf(".");
    if (
      separator <= 0 ||
      separator === payload.length - 1 ||
      payload.indexOf(".", separator + 1) >= 0
    ) {
      throw new PiiCipherError("Malformed PII KMS envelope");
    }
    const wrappedDek = payload.slice(0, separator);
    const blob = unb64url(payload.slice(separator + 1));
    const aad = canonicalAad(context);
    const dek = await this.kms.decrypt(wrappedDek, aad);
    return decryptAesGcm(await importAesKey(dek), blob, aad);
  }
}

export class LocalPiiCipher implements PiiCipher {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly masterKeyBase64: string) {}

  private getKey(): Promise<CryptoKey> {
    if (this.key) {
      return this.key;
    }
    this.key = (async () => {
      const raw = unb64url(this.masterKeyBase64);
      if (raw.length !== 32) {
        throw new PiiCipherError(
          `Invalid COUNTERPARTY_PII_ENCRYPTION_KEY length: expected 32 bytes, got ${raw.length}`
        );
      }
      const source = await crypto.subtle.importKey("raw", Uint8Array.from(raw), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: LOCAL_SALT,
          info: new TextEncoder().encode("sdp-counterparty-pii"),
        },
        source,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    })();
    return this.key;
  }

  async encrypt(context: PiiCipherContext, plaintext: string): Promise<string> {
    const encrypted = await encryptAesGcm(await this.getKey(), plaintext, canonicalAad(context));
    return `${LOCAL_PREFIX}${b64url(encrypted)}`;
  }

  async decrypt(context: PiiCipherContext, ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith(LOCAL_PREFIX)) {
      throw new PiiCipherError("Ciphertext is not a local PII envelope");
    }
    return decryptAesGcm(
      await this.getKey(),
      unb64url(ciphertext.slice(LOCAL_PREFIX.length)),
      canonicalAad(context)
    );
  }
}

export function createPiiCipher(env: Env): PiiCipher {
  if (getDeploymentMode(env) === "managed") {
    if (!env.COUNTERPARTY_PII_KMS_KEY_NAME) {
      throw new PiiCipherError("COUNTERPARTY_PII_KMS_KEY_NAME is required for managed deployments");
    }
    const tokenProvider = new GcpMetadataTokenProvider({
      metadataTokenUrl: env.COUNTERPARTY_PII_KMS_METADATA_TOKEN_URL,
    });
    return new KmsPiiCipher(
      new KmsClient({
        keyName: env.COUNTERPARTY_PII_KMS_KEY_NAME,
        apiBaseUrl: env.COUNTERPARTY_PII_KMS_API_BASE_URL,
        tokenProvider,
      })
    );
  }

  if (!env.COUNTERPARTY_PII_ENCRYPTION_KEY) {
    throw new PiiCipherError(
      "COUNTERPARTY_PII_ENCRYPTION_KEY is required for self-hosted deployments"
    );
  }
  return new LocalPiiCipher(env.COUNTERPARTY_PII_ENCRYPTION_KEY);
}
