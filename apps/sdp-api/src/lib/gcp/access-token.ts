const DEFAULT_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const EXPIRY_SKEW_SECONDS = 60;

export interface GcpMetadataTokenProviderOptions {
  metadataTokenUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number; // ms
}

export class GcpAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpAccessTokenError";
  }
}

export class GcpMetadataTokenProvider {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(opts: GcpMetadataTokenProviderOptions = {}) {
    this.url = opts.metadataTokenUrl ?? DEFAULT_METADATA_TOKEN_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) {
      return this.cached.token;
    }
    const res = await this.fetchImpl(this.url, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) {
      throw new GcpAccessTokenError(`metadata token request failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new GcpAccessTokenError("metadata token response missing access_token");
    }
    const ttl = (body.expires_in ?? 3600) - EXPIRY_SKEW_SECONDS;
    this.cached = { token: body.access_token, expiresAtMs: this.now() + ttl * 1000 };
    return this.cached.token;
  }
}
