export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface KmsClientOptions {
  keyName: string;
  apiBaseUrl?: string;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
}

export class KmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsError";
  }
}

const stdB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class KmsClient {
  private readonly keyName: string;
  private readonly base: string;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: KmsClientOptions) {
    this.keyName = opts.keyName;
    this.base = opts.apiBaseUrl ?? "https://cloudkms.googleapis.com";
    this.tokenProvider = opts.tokenProvider;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async encrypt(plaintext: Uint8Array, aad: string): Promise<string> {
    const body = await this.call("encrypt", {
      plaintext: stdB64(plaintext),
      additionalAuthenticatedData: btoa(aad),
    });
    if (!body.ciphertext) throw new KmsError("KMS encrypt response missing ciphertext");
    return body.ciphertext;
  }

  async decrypt(ciphertext: string, aad: string): Promise<Uint8Array> {
    const body = await this.call("decrypt", {
      ciphertext,
      additionalAuthenticatedData: btoa(aad),
    });
    if (!body.plaintext) throw new KmsError("KMS decrypt response missing plaintext");
    return fromB64(body.plaintext);
  }

  private async call(op: "encrypt" | "decrypt", payload: Record<string, string>) {
    const token = await this.tokenProvider.getToken();
    const res = await this.fetchImpl(`${this.base}/v1/${this.keyName}:${op}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new KmsError(`KMS ${op} failed: ${res.status}`);
    return (await res.json()) as { ciphertext?: string; plaintext?: string };
  }
}
