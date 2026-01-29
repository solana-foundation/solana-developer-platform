/**
 * Encryption Service
 *
 * Provides AES-256-GCM encryption for storing sensitive data like private keys.
 * Uses HKDF to derive organization-specific keys from a master encryption key.
 *
 * Security design:
 * - Master key (CUSTODY_ENCRYPTION_KEY) is a 256-bit key stored in secrets
 * - Each org gets a unique derived key via HKDF with orgId as info
 * - AES-GCM provides authenticated encryption (confidentiality + integrity)
 * - IV is randomly generated per encryption and prepended to ciphertext
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EncryptionResult {
  ciphertext: string; // Base64-encoded IV + ciphertext + auth tag
}

export interface EncryptionConfig {
  masterKey: string; // Base64-encoded 256-bit master key
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // bits
const IV_LENGTH = 12; // bytes (96 bits, recommended for AES-GCM)
const SALT = new TextEncoder().encode("sdp-custody-encryption-v1");

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class EncryptionService {
  private masterKey: CryptoKey | null = null;
  private derivedKeys = new Map<string, CryptoKey>();
  private masterKeyBase64: string;

  constructor(config: EncryptionConfig) {
    this.masterKeyBase64 = config.masterKey;
  }

  /**
   * Initialize the master key from the base64 string.
   * Called lazily on first encryption/decryption operation.
   */
  private async ensureMasterKey(): Promise<CryptoKey> {
    if (this.masterKey) {
      return this.masterKey;
    }

    const keyData = decodeBase64(this.masterKeyBase64);

    if (keyData.length !== 32) {
      throw new EncryptionError(
        `Invalid master key length: expected 32 bytes, got ${keyData.length}`
      );
    }

    // Import as HKDF source key for deriving org-specific keys
    this.masterKey = await crypto.subtle.importKey("raw", keyData, "HKDF", false, ["deriveKey"]);

    return this.masterKey;
  }

  /**
   * Derive an organization-specific encryption key using HKDF.
   * Keys are cached for the lifetime of the service instance.
   */
  private async deriveKeyForOrg(orgId: string): Promise<CryptoKey> {
    const cached = this.derivedKeys.get(orgId);
    if (cached) {
      return cached;
    }

    const masterKey = await this.ensureMasterKey();
    const info = new TextEncoder().encode(`org:${orgId}`);

    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: SALT,
        info,
      },
      masterKey,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ["encrypt", "decrypt"]
    );

    this.derivedKeys.set(orgId, derivedKey);
    return derivedKey;
  }

  /**
   * Encrypt plaintext data for a specific organization.
   *
   * @param orgId - Organization ID used to derive the encryption key
   * @param plaintext - Data to encrypt (will be UTF-8 encoded)
   * @returns Base64-encoded ciphertext with IV prepended
   */
  async encrypt(orgId: string, plaintext: string): Promise<EncryptionResult> {
    const key = await this.deriveKeyForOrg(orgId);

    // Generate random IV for each encryption
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const plaintextBytes = new TextEncoder().encode(plaintext);

    const ciphertextBytes = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      plaintextBytes
    );

    // Prepend IV to ciphertext for storage
    const combined = new Uint8Array(iv.length + ciphertextBytes.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertextBytes), iv.length);

    return {
      ciphertext: encodeBase64(combined),
    };
  }

  /**
   * Decrypt ciphertext for a specific organization.
   *
   * @param orgId - Organization ID used to derive the decryption key
   * @param ciphertext - Base64-encoded IV + ciphertext (from encrypt())
   * @returns Decrypted plaintext string
   * @throws EncryptionError if decryption fails (wrong key, tampered data, etc.)
   */
  async decrypt(orgId: string, ciphertext: string): Promise<string> {
    const key = await this.deriveKeyForOrg(orgId);

    const combined = decodeBase64(ciphertext);

    if (combined.length < IV_LENGTH + 16) {
      // 16 bytes minimum for AES-GCM auth tag
      throw new EncryptionError("Ciphertext too short to be valid");
    }

    // Extract IV and ciphertext
    const iv = combined.slice(0, IV_LENGTH);
    const encryptedData = combined.slice(IV_LENGTH);

    try {
      const plaintextBytes = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv },
        key,
        encryptedData
      );

      return new TextDecoder().decode(plaintextBytes);
    } catch {
      throw new EncryptionError(
        "Decryption failed: invalid key, corrupted data, or tampered ciphertext"
      );
    }
  }

  /**
   * Encrypt a private key for storage.
   * Convenience method that handles the common case of encrypting Solana private keys.
   *
   * @param orgId - Organization ID
   * @param privateKeyBase58 - Base58-encoded Solana private key
   * @returns Encrypted key ready for database storage
   */
  async encryptPrivateKey(orgId: string, privateKeyBase58: string): Promise<string> {
    const result = await this.encrypt(orgId, privateKeyBase58);
    return result.ciphertext;
  }

  /**
   * Decrypt a stored private key.
   *
   * @param orgId - Organization ID
   * @param encryptedKey - Encrypted key from database
   * @returns Base58-encoded Solana private key
   */
  async decryptPrivateKey(orgId: string, encryptedKey: string): Promise<string> {
    return this.decrypt(orgId, encryptedKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an EncryptionService from environment variables.
 *
 * @param masterKey - CUSTODY_ENCRYPTION_KEY from environment
 * @throws EncryptionError if the key is not configured
 */
export function createEncryptionService(masterKey: string | undefined): EncryptionService {
  if (!masterKey) {
    throw new EncryptionError("CUSTODY_ENCRYPTION_KEY environment variable is not configured");
  }

  return new EncryptionService({ masterKey });
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════════════════

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  // Handle URL-safe base64 encoding
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Key Generation Utility (for initial setup)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a new 256-bit encryption key.
 * Use this to create the CUSTODY_ENCRYPTION_KEY value.
 *
 * @returns Base64-encoded 32-byte key
 */
export async function generateEncryptionKey(): Promise<string> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64(key);
}
