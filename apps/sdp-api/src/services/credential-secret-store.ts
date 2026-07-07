import { getDeploymentMode } from "@/lib/runtime-env";
import { createEncryptionService, type EncryptionService } from "@/services/encryption.service";
import type { Env } from "@/types/env";

export type CredentialSecretStorageBackend = "gcp_secret_manager" | "encrypted_db" | "runtime_env";

export type CredentialSecretPayload = Record<string, unknown>;

export interface StoredCredentialSecret {
  storageBackend: CredentialSecretStorageBackend;
  secretRef?: string;
  secretVersionRef?: string;
  encryptedSecretPayload?: string;
  runtimeEnvFields?: Record<string, keyof Env & string>;
}

export interface WriteCredentialSecretParams {
  orgId: string;
  provider: string;
  providerCredentialId: string;
  payload: CredentialSecretPayload;
  existingSecretRef?: string;
}

export interface ReadCredentialSecretParams {
  orgId: string;
  stored: StoredCredentialSecret;
}

export interface DestroyCredentialSecretVersionParams {
  secretVersionRef: string;
}

export interface CredentialSecretStore {
  readonly storageBackend: CredentialSecretStorageBackend;
  write(params: WriteCredentialSecretParams): Promise<StoredCredentialSecret>;
  read(params: ReadCredentialSecretParams): Promise<CredentialSecretPayload>;
  destroyVersion(params: DestroyCredentialSecretVersionParams): Promise<void>;
}

export class CredentialSecretStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CONFIGURATION"
      | "INVALID_SECRET_REF"
      | "MISSING_SECRET"
      | "UNSUPPORTED_OPERATION"
      | "UPSTREAM_ERROR"
  ) {
    super(message);
    this.name = "CredentialSecretStoreError";
  }
}

export class EncryptedDbCredentialSecretStore implements CredentialSecretStore {
  readonly storageBackend = "encrypted_db" as const;

  constructor(private readonly encryption: EncryptionService) {}

  async write(params: WriteCredentialSecretParams): Promise<StoredCredentialSecret> {
    let encryptedSecretPayload: string;
    try {
      encryptedSecretPayload = (
        await this.encryption.encrypt(params.orgId, JSON.stringify(params.payload))
      ).ciphertext;
    } catch (error) {
      if (error instanceof CredentialSecretStoreError) {
        throw error;
      }

      throw new CredentialSecretStoreError(
        "Encrypted DB credential payload could not be encrypted",
        "INVALID_CONFIGURATION"
      );
    }

    return {
      storageBackend: this.storageBackend,
      encryptedSecretPayload,
    };
  }

  async read(params: ReadCredentialSecretParams): Promise<CredentialSecretPayload> {
    const encryptedPayload = params.stored.encryptedSecretPayload;
    if (!encryptedPayload) {
      throw new CredentialSecretStoreError(
        "Encrypted DB credential is missing encrypted_secret_payload",
        "MISSING_SECRET"
      );
    }

    try {
      return parseSecretPayload(await this.encryption.decrypt(params.orgId, encryptedPayload));
    } catch (error) {
      if (error instanceof CredentialSecretStoreError) {
        throw error;
      }

      throw new CredentialSecretStoreError(
        "Encrypted DB credential payload could not be decrypted",
        "MISSING_SECRET"
      );
    }
  }

  async destroyVersion(_params: DestroyCredentialSecretVersionParams): Promise<void> {
    throw new CredentialSecretStoreError(
      "Encrypted DB credentials do not have external versions to destroy",
      "UNSUPPORTED_OPERATION"
    );
  }
}

export class RuntimeEnvCredentialSecretStore implements CredentialSecretStore {
  readonly storageBackend = "runtime_env" as const;

  constructor(private readonly env: Env) {}

  async write(_params: WriteCredentialSecretParams): Promise<StoredCredentialSecret> {
    throw new CredentialSecretStoreError(
      "Runtime env credentials are read-only and must be supplied by deployment configuration",
      "UNSUPPORTED_OPERATION"
    );
  }

  async read(params: ReadCredentialSecretParams): Promise<CredentialSecretPayload> {
    const fields = params.stored.runtimeEnvFields;
    if (!fields || Object.keys(fields).length === 0) {
      throw new CredentialSecretStoreError(
        "Runtime env credential is missing runtimeEnvFields metadata",
        "MISSING_SECRET"
      );
    }

    const payload: CredentialSecretPayload = {};
    const source = this.env as unknown as Record<string, unknown>;

    for (const [fieldName, envKey] of Object.entries(fields)) {
      if (!isSafePayloadField(fieldName)) {
        throw new CredentialSecretStoreError(
          `Invalid runtime credential field name: ${fieldName}`,
          "INVALID_CONFIGURATION"
        );
      }

      const value = source[envKey];
      if (typeof value !== "string" || value.length === 0) {
        throw new CredentialSecretStoreError(
          `Runtime credential env var is not configured: ${envKey}`,
          "MISSING_SECRET"
        );
      }

      payload[fieldName] = value;
    }

    return payload;
  }

  async destroyVersion(_params: DestroyCredentialSecretVersionParams): Promise<void> {
    throw new CredentialSecretStoreError(
      "Runtime env credentials do not have external versions to destroy",
      "UNSUPPORTED_OPERATION"
    );
  }
}

export interface GcpSecretManagerCredentialSecretStoreOptions {
  projectId: string;
  secretPrefix: string;
  apiBaseUrl?: string;
  accessToken?: string;
  fetcher?: typeof fetch;
  metadataTokenUrl?: string;
  now?: () => number;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

export class GcpSecretManagerCredentialSecretStore implements CredentialSecretStore {
  readonly storageBackend = "gcp_secret_manager" as const;

  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly metadataTokenUrl: string;
  private readonly now: () => number;
  private cachedToken: CachedAccessToken | null = null;

  constructor(private readonly options: GcpSecretManagerCredentialSecretStoreOptions) {
    assertGcpProjectId(options.projectId);
    assertGcpSecretPrefix(options.secretPrefix);

    this.apiBaseUrl =
      options.apiBaseUrl?.replace(/\/+$/, "") ?? "https://secretmanager.googleapis.com";
    this.fetcher = options.fetcher ?? fetch;
    this.metadataTokenUrl =
      options.metadataTokenUrl ??
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
    this.now = options.now ?? Date.now;
  }

  async write(params: WriteCredentialSecretParams): Promise<StoredCredentialSecret> {
    const secretRef =
      params.existingSecretRef ??
      buildGcpSecretRef({
        projectId: this.options.projectId,
        secretPrefix: this.options.secretPrefix,
        providerCredentialId: params.providerCredentialId,
      });

    assertManagedSecretRef(secretRef, {
      projectId: this.options.projectId,
      secretPrefix: this.options.secretPrefix,
      requireVersion: false,
    });

    if (!params.existingSecretRef) {
      await this.createSecretIfMissing(secretRef, {
        provider: params.provider,
        orgId: params.orgId,
      });
    }

    const versionRef = await this.addSecretVersion(secretRef, JSON.stringify(params.payload));

    return {
      storageBackend: this.storageBackend,
      secretRef,
      secretVersionRef: versionRef,
    };
  }

  async read(params: ReadCredentialSecretParams): Promise<CredentialSecretPayload> {
    const secretVersionRef = params.stored.secretVersionRef;
    if (!secretVersionRef) {
      throw new CredentialSecretStoreError(
        "GCP Secret Manager credential is missing secret_version_ref",
        "MISSING_SECRET"
      );
    }

    assertManagedSecretRef(secretVersionRef, {
      projectId: this.options.projectId,
      secretPrefix: this.options.secretPrefix,
      requireVersion: true,
    });

    const response = await this.request<{ payload?: { data?: string } }>(
      `${secretVersionRef}:access`,
      { method: "GET" }
    );

    const data = response.payload?.data;
    if (!data) {
      throw new CredentialSecretStoreError(
        "GCP Secret Manager access response did not include payload data",
        "UPSTREAM_ERROR"
      );
    }

    let decoded: string;
    try {
      decoded = decodeBase64ToUtf8(data);
    } catch {
      throw new CredentialSecretStoreError(
        "GCP Secret Manager returned a payload with invalid base64 encoding",
        "UPSTREAM_ERROR"
      );
    }

    return parseSecretPayload(decoded);
  }

  async destroyVersion(params: DestroyCredentialSecretVersionParams): Promise<void> {
    assertManagedSecretRef(params.secretVersionRef, {
      projectId: this.options.projectId,
      secretPrefix: this.options.secretPrefix,
      requireVersion: true,
    });

    await this.request(`${params.secretVersionRef}:destroy`, {
      method: "POST",
      body: "{}",
    });
  }

  private async createSecretIfMissing(
    secretRef: string,
    labels: { provider: string; orgId: string }
  ): Promise<void> {
    const secretId = secretRef.split("/").at(-1);
    if (!secretId) {
      throw new CredentialSecretStoreError("Invalid GCP secret ref", "INVALID_SECRET_REF");
    }

    const response = await this.rawRequest(
      `projects/${this.options.projectId}/secrets?secretId=${encodeURIComponent(secretId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          labels: {
            sdp_purpose: "provider_credentials",
            sdp_provider: toGcpLabelValue(labels.provider),
            sdp_org: toGcpLabelValue(labels.orgId),
          },
          replication: {
            automatic: {},
          },
        }),
      }
    );

    if (response.status === 409) {
      return;
    }

    await parseGcpResponse(response);
  }

  private async addSecretVersion(secretRef: string, payload: string): Promise<string> {
    const response = await this.request<{ name?: string }>(`${secretRef}:addVersion`, {
      method: "POST",
      body: JSON.stringify({
        payload: {
          data: encodeUtf8ToBase64(payload),
        },
      }),
    });

    if (!response.name) {
      throw new CredentialSecretStoreError(
        "GCP Secret Manager addVersion response did not include version name",
        "UPSTREAM_ERROR"
      );
    }

    assertManagedSecretRef(response.name, {
      projectId: this.options.projectId,
      secretPrefix: this.options.secretPrefix,
      requireVersion: true,
    });

    return response.name;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.rawRequest(path, init);
    return parseGcpResponse<T>(response);
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    const accessToken = await this.getAccessToken();
    try {
      return await this.fetcher(`${this.apiBaseUrl}/v1/${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (error instanceof CredentialSecretStoreError) {
        throw error;
      }

      throw new CredentialSecretStoreError(
        "GCP Secret Manager request failed before receiving a response",
        "UPSTREAM_ERROR"
      );
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.options.accessToken) {
      return this.options.accessToken;
    }

    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > this.now()) {
      return this.cachedToken.accessToken;
    }

    let response: Response;
    try {
      response = await this.fetcher(this.metadataTokenUrl, {
        headers: {
          "Metadata-Flavor": "Google",
        },
      });
    } catch (error) {
      if (error instanceof CredentialSecretStoreError) {
        throw error;
      }

      throw new CredentialSecretStoreError(
        "GCP metadata token request failed before receiving a response",
        "UPSTREAM_ERROR"
      );
    }

    const token = await parseGcpResponse<{ access_token?: string; expires_in?: number }>(response);
    if (!token.access_token) {
      throw new CredentialSecretStoreError(
        "GCP metadata token response did not include an access token",
        "UPSTREAM_ERROR"
      );
    }

    this.cachedToken = {
      accessToken: token.access_token,
      expiresAtMs: this.now() + Math.max(0, token.expires_in ?? 300) * 1000,
    };

    return token.access_token;
  }
}

export function createCredentialSecretStore(env: Env): CredentialSecretStore {
  const backend = resolveCredentialSecretStoreBackend(env);

  if (backend === "gcp_secret_manager") {
    return new GcpSecretManagerCredentialSecretStore({
      projectId: requireEnv(env.GCP_SECRET_MANAGER_PROJECT_ID, "GCP_SECRET_MANAGER_PROJECT_ID"),
      secretPrefix: env.GCP_SECRET_MANAGER_SECRET_PREFIX ?? "sdp-provider-credentials",
      apiBaseUrl: env.GCP_SECRET_MANAGER_API_BASE_URL,
    });
  }

  if (backend === "runtime_env") {
    return new RuntimeEnvCredentialSecretStore(env);
  }

  return new EncryptedDbCredentialSecretStore(
    createEncryptionService(requireEnv(env.CUSTODY_ENCRYPTION_KEY, "CUSTODY_ENCRYPTION_KEY"))
  );
}

export function resolveCredentialSecretStoreBackend(env: Env): CredentialSecretStorageBackend {
  const configured = env.CREDENTIAL_SECRET_STORE_BACKEND;
  if (configured) {
    if (
      configured !== "gcp_secret_manager" &&
      configured !== "encrypted_db" &&
      configured !== "runtime_env"
    ) {
      throw new CredentialSecretStoreError(
        `Invalid CREDENTIAL_SECRET_STORE_BACKEND: ${configured}`,
        "INVALID_CONFIGURATION"
      );
    }

    return configured;
  }

  try {
    return getDeploymentMode(env) === "self_hosted" ? "encrypted_db" : "gcp_secret_manager";
  } catch (error) {
    if (error instanceof CredentialSecretStoreError) {
      throw error;
    }

    throw new CredentialSecretStoreError(
      error instanceof Error ? error.message : "Invalid deployment mode configuration",
      "INVALID_CONFIGURATION"
    );
  }
}

function buildGcpSecretRef(params: {
  projectId: string;
  secretPrefix: string;
  providerCredentialId: string;
}): string {
  const secretId = `${params.secretPrefix}-${params.providerCredentialId}`;
  assertGcpSecretId(secretId);
  return `projects/${params.projectId}/secrets/${secretId}`;
}

function assertManagedSecretRef(
  ref: string,
  options: { projectId: string; secretPrefix: string; requireVersion: boolean }
): void {
  const match = ref.match(/^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/([^/]+))?$/);
  if (!match) {
    throw new CredentialSecretStoreError("Invalid GCP Secret Manager ref", "INVALID_SECRET_REF");
  }

  const [, projectId, secretId, version] = match;
  if (projectId !== options.projectId) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager ref points at the wrong project",
      "INVALID_SECRET_REF"
    );
  }

  if (!secretId.startsWith(`${options.secretPrefix}-`)) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager ref is outside the managed credential prefix",
      "INVALID_SECRET_REF"
    );
  }

  assertGcpSecretId(secretId);

  if (options.requireVersion && !version?.match(/^[1-9][0-9]*$/)) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager reads must use an exact numeric version ref",
      "INVALID_SECRET_REF"
    );
  }

  if (!options.requireVersion && version) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager writes must target a secret ref, not a version ref",
      "INVALID_SECRET_REF"
    );
  }
}

async function parseGcpResponse<T = unknown>(response: Response): Promise<T> {
  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new CredentialSecretStoreError(
        "GCP Secret Manager returned an unexpected response format",
        "UPSTREAM_ERROR"
      );
    }
  }

  let statusText = response.statusText;
  try {
    const parsed = (await response.json()) as { error?: { status?: string; message?: string } };
    statusText = parsed.error?.status ?? parsed.error?.message ?? statusText;
  } catch {
    // Keep the HTTP status text only. The body might contain secret material.
  }

  throw new CredentialSecretStoreError(
    `GCP Secret Manager request failed (${response.status} ${statusText})`,
    "UPSTREAM_ERROR"
  );
}

function parseSecretPayload(value: string): CredentialSecretPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CredentialSecretStoreError(
      "Credential secret payload must be a valid JSON object",
      "INVALID_CONFIGURATION"
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialSecretStoreError(
      "Credential secret payload must be a JSON object",
      "INVALID_CONFIGURATION"
    );
  }

  return parsed as CredentialSecretPayload;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new CredentialSecretStoreError(`${name} is not configured`, "INVALID_CONFIGURATION");
  }

  return value;
}

function assertGcpProjectId(projectId: string): void {
  if (!projectId.match(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager project id is invalid",
      "INVALID_CONFIGURATION"
    );
  }
}

function assertGcpSecretPrefix(prefix: string): void {
  if (!prefix.match(/^[A-Za-z0-9_-]{1,200}$/)) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager secret prefix is invalid",
      "INVALID_CONFIGURATION"
    );
  }
}

function assertGcpSecretId(secretId: string): void {
  if (!secretId.match(/^[A-Za-z0-9_-]{1,255}$/)) {
    throw new CredentialSecretStoreError(
      "GCP Secret Manager secret id is invalid",
      "INVALID_SECRET_REF"
    );
  }
}

function isSafePayloadField(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
}

function toGcpLabelValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}

function encodeUtf8ToBase64(value: string): string {
  return encodeBase64(new TextEncoder().encode(value));
}

function decodeBase64ToUtf8(value: string): string {
  return new TextDecoder().decode(decodeBase64(value));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
