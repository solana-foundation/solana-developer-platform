export const KMS_ENVELOPE_VERSION = "sdp-custody-kms-v2";
const PREFIX = "v2.";
const IV_LENGTH = 12;

export interface EnvelopeKms {
  encrypt(plaintext: Uint8Array, aad: string): Promise<string>;
  decrypt(ciphertext: string, aad: string): Promise<Uint8Array>;
}

export class EnvelopeCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeCipherError";
  }
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4)), (c) =>
    c.charCodeAt(0)
  );
};

export class KmsEnvelopeCipher {
  private readonly kms: EnvelopeKms;
  constructor(opts: { kms: EnvelopeKms }) {
    this.kms = opts.kms;
  }

  async encrypt(
    orgId: string,
    plaintext: string
  ): Promise<{ ciphertext: string; version: string }> {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
    );
    const wrapped = await this.kms.encrypt(dek, `org:${orgId}`);
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv, 0);
    blob.set(ct, iv.length);
    return { ciphertext: `${PREFIX}${wrapped}.${b64url(blob)}`, version: KMS_ENVELOPE_VERSION };
  }

  async decrypt(orgId: string, ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith(PREFIX)) {
      throw new EnvelopeCipherError("ciphertext is not a v2 envelope");
    }
    const [, wrappedPart, blobPart] = ciphertext.split(".");
    if (!wrappedPart || !blobPart) throw new EnvelopeCipherError("malformed v2 envelope");
    const dek = await this.kms.decrypt(wrappedPart, `org:${orgId}`);
    const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
    const blob = unb64url(blobPart);
    const iv = blob.slice(0, IV_LENGTH);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, blob.slice(IV_LENGTH));
    return new TextDecoder().decode(pt);
  }
}
