import { Buffer } from "node:buffer";
import { isFullSigningPort } from "@sdp/custody/signing";
import { describe, expect, it } from "vitest";
import { KeychainDfnsAdapter, type SigningConfigRecord } from "@/services/adapters";
import { createAdapterFromEncryptedConfig } from "@/services/domain/signing.service";
import { createEncryptionService } from "@/services/encryption.service";
import type { Env } from "@/types/env";

const TEST_ORG_ID = "org_dfns_legacy";

describe("signing.service dfns compatibility", () => {
  it("resolves DFNS adapter when encrypted config omits provider field", async () => {
    const env = createTestEnv();
    const encryptedConfig = await encryptConfig(env, JSON.stringify({ walletId: "wa_legacy_1" }));
    const record = createRecord({
      config: encryptedConfig,
      defaultWalletId: null,
    });

    const adapter = await createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record);

    expect(adapter).toBeInstanceOf(KeychainDfnsAdapter);
    expect(adapter.providerId).toBe("dfns");
  });

  it("rejects encrypted non-JSON payloads for clean custody configuration flow", async () => {
    const env = createTestEnv();
    const encryptedConfig = await encryptConfig(env, "legacy-config-placeholder");
    const record = createRecord({
      config: encryptedConfig,
      defaultWalletId: "dfns_wa_legacy_2",
    });

    await expect(createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record)).rejects.toThrow(
      "Custody configuration must be a valid JSON object"
    );
  });

  it("treats anchorage as lifecycle-only (non-signing) configuration", async () => {
    const env = createTestEnv();
    const encryptedConfig = await encryptConfig(
      env,
      JSON.stringify({ apiBaseUrl: "https://example.com" })
    );
    const record = {
      ...createRecord({
        config: encryptedConfig,
        defaultWalletId: "anchorage_wa_123",
      }),
      provider: "anchorage" as const,
    };

    const adapter = await createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record);

    expect(adapter.providerId).toBe("anchorage");
    expect(isFullSigningPort(adapter)).toBe(false);
  });
});

function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as DatabaseClient,
    CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DFNS_AUTH_TOKEN: "dfns-auth-token",
    DFNS_CREDENTIAL_ID: "dfns-credential-id",
    DFNS_PRIVATE_KEY: "dfns-test-private-key",
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    ...overrides,
  } as Env;
}

async function encryptConfig(env: Env, plaintext: string): Promise<string> {
  const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
  const encrypted = await encryption.encrypt(TEST_ORG_ID, plaintext);
  return encrypted.ciphertext;
}

function createRecord(params: {
  config: string;
  defaultWalletId: string | null;
}): SigningConfigRecord {
  return {
    id: "cust_dfns_legacy_test",
    organizationId: TEST_ORG_ID,
    projectId: null,
    provider: "dfns",
    config: params.config,
    defaultWalletId: params.defaultWalletId,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
