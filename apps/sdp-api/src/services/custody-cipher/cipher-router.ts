import { GcpMetadataTokenProvider } from "@/lib/gcp/access-token";
import { KmsClient } from "@/lib/gcp/kms-client";
import type { Env } from "@/types/env";
import { createEncryptionService } from "../encryption.service";
import { KmsEnvelopeCipher } from "./envelope-cipher";

const V2_PREFIX = "v2.";

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

export class CustodyCipherRouter implements CustodyCipher {
  private readonly legacyKey?: string;
  private readonly envelope: KmsEnvelopeCipher | null;
  private readonly activeScheme: "legacy" | "v2";

  constructor(opts: {
    legacyKey?: string;
    envelope: KmsEnvelopeCipher | null;
    activeScheme: "legacy" | "v2";
  }) {
    this.legacyKey = opts.legacyKey;
    this.envelope = opts.envelope;
    this.activeScheme = opts.activeScheme;
  }

  async encrypt(orgId: string, plaintext: string): Promise<string> {
    if (this.activeScheme === "v2") {
      if (!this.envelope) throw new CustodyCipherError("v2 active but KMS envelope not configured");
      return (await this.envelope.encrypt(orgId, plaintext)).ciphertext;
    }
    if (!this.legacyKey)
      throw new CustodyCipherError("legacy active but CUSTODY_ENCRYPTION_KEY not set");
    return (await createEncryptionService(this.legacyKey).encrypt(orgId, plaintext)).ciphertext;
  }

  async decrypt(orgId: string, ciphertext: string): Promise<string> {
    if (ciphertext.startsWith(V2_PREFIX)) {
      if (!this.envelope)
        throw new CustodyCipherError("v2 ciphertext but KMS envelope not configured");
      return this.envelope.decrypt(orgId, ciphertext);
    }
    if (!this.legacyKey)
      throw new CustodyCipherError("legacy ciphertext but CUSTODY_ENCRYPTION_KEY not set");
    return createEncryptionService(this.legacyKey).decrypt(orgId, ciphertext);
  }
}

export function createCustodyCipher(env: Env): CustodyCipher {
  const keyName = env.CUSTODY_KMS_KEY_NAME;
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
    legacyKey: env.CUSTODY_ENCRYPTION_KEY,
    envelope,
    activeScheme: keyName ? "v2" : "legacy",
  });
}
