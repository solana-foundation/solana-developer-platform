import { GcpMetadataTokenProvider } from "@/lib/gcp/access-token";
import { KmsClient } from "@/lib/gcp/kms-client";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { Env } from "@/types/env";
import { createEncryptionService } from "../encryption.service";
import { KmsEnvelopeCipher } from "./envelope-cipher";

const V2_PREFIX = "v2.";

export function isV2Ciphertext(ciphertext: string): boolean {
  return ciphertext.startsWith(V2_PREFIX);
}

export interface CustodyCipher {
  encrypt(orgId: string, plaintext: string): Promise<string>;
  decrypt(orgId: string, ciphertext: string): Promise<string>;
}

export class CustodyCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodyCipherError";
  }
}

const DEFAULT_LEGACY_KEY_ENV_NAME = "CUSTODY_ENCRYPTION_KEY";

export class CustodyCipherRouter implements CustodyCipher {
  private readonly legacyKey?: string;
  private readonly envelope: KmsEnvelopeCipher | null;
  private readonly activeScheme: "legacy" | "v2";
  /**
   * Which env var supplies `legacyKey`, for error messages only. Non-custody
   * callers hold their own key, so naming the custody one would tell an operator
   * to reuse the exact key the separation exists to keep apart.
   */
  private readonly legacyKeyEnvName: string;

  constructor(opts: {
    legacyKey?: string;
    envelope: KmsEnvelopeCipher | null;
    activeScheme: "legacy" | "v2";
    legacyKeyEnvName?: string;
  }) {
    this.legacyKey = opts.legacyKey;
    this.envelope = opts.envelope;
    this.activeScheme = opts.activeScheme;
    this.legacyKeyEnvName = opts.legacyKeyEnvName ?? DEFAULT_LEGACY_KEY_ENV_NAME;
  }

  async encrypt(orgId: string, plaintext: string): Promise<string> {
    if (this.activeScheme === "v2") {
      if (!this.envelope) throw new CustodyCipherError("v2 active but KMS envelope not configured");
      return (await this.envelope.encrypt(orgId, plaintext)).ciphertext;
    }
    if (!this.legacyKey)
      throw new CustodyCipherError(`legacy active but ${this.legacyKeyEnvName} not set`);
    return (await createEncryptionService(this.legacyKey).encrypt(orgId, plaintext)).ciphertext;
  }

  async decrypt(orgId: string, ciphertext: string): Promise<string> {
    if (ciphertext.startsWith(V2_PREFIX)) {
      if (!this.envelope)
        throw new CustodyCipherError("v2 ciphertext but KMS envelope not configured");
      return this.envelope.decrypt(orgId, ciphertext);
    }
    if (!this.legacyKey)
      throw new CustodyCipherError(`legacy ciphertext but ${this.legacyKeyEnvName} not set`);
    return createEncryptionService(this.legacyKey).decrypt(orgId, ciphertext);
  }
}

/** KMS transport settings, shared by every caller. Not key material. */
type KmsTransportEnv = Pick<Env, "CUSTODY_KMS_API_BASE_URL" | "CUSTODY_KMS_METADATA_TOKEN_URL">;

/**
 * Build a router over a caller-supplied key pair: a legacy AES-GCM master key
 * and an optional Cloud KMS key that switches new writes to `v2.` envelopes.
 * Decryption always dispatches on the ciphertext prefix, so the two coexist.
 *
 * The `CUSTODY_KMS_API_BASE_URL` / `CUSTODY_KMS_METADATA_TOKEN_URL` names are
 * historical — they configure the KMS endpoint and the metadata token source for
 * the whole process, not just custody, so non-custody callers reuse them too.
 */
export function createCipherRouter(
  env: KmsTransportEnv,
  opts: { legacyKey?: string; kmsKeyName?: string; legacyKeyEnvName?: string }
): CustodyCipher {
  const keyName = opts.kmsKeyName;
  let envelope: KmsEnvelopeCipher | null = null;
  if (keyName) {
    const tokenProvider = new GcpMetadataTokenProvider({
      metadataTokenUrl: env.CUSTODY_KMS_METADATA_TOKEN_URL,
    });
    const kms = new KmsClient({
      keyName,
      apiBaseUrl: env.CUSTODY_KMS_API_BASE_URL,
      tokenProvider,
    });
    envelope = new KmsEnvelopeCipher({ kms });
  }
  return new CustodyCipherRouter({
    legacyKey: opts.legacyKey,
    envelope,
    activeScheme: keyName ? "v2" : "legacy",
    ...(opts.legacyKeyEnvName ? { legacyKeyEnvName: opts.legacyKeyEnvName } : {}),
  });
}

export function assertCustodyEncryptionScheme(env: Env): void {
  if (env.CUSTODY_KMS_KEY_NAME?.trim()) {
    return;
  }
  if (isSelfHostedDeployment(env)) {
    return;
  }
  throw new CustodyCipherError(
    "CUSTODY_KMS_KEY_NAME is required unless SDP_DEPLOYMENT_MODE=self_hosted; " +
      "refusing to write custody secrets with the legacy environment key"
  );
}

export function createCustodyCipher(env: Env): CustodyCipher {
  return createCipherRouter(env, {
    legacyKey: env.CUSTODY_ENCRYPTION_KEY,
    kmsKeyName: env.CUSTODY_KMS_KEY_NAME,
  });
}
