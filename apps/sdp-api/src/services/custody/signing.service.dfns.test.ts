import { KeychainDfnsAdapter } from "@sdp/custody/providers/dfns/keychain.adapter";
import { isFullSigningPort } from "@sdp/custody/signing";
import { aroundEach, describe, expect, it } from "vitest";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import { createAdapterFromEncryptedConfig } from "@/services/custody/signing/provider-adapter-factory";
import { createEncryptionService } from "@/services/encryption.service";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { TEST_LEGACY_CUSTODY_KEY } from "@/test/helpers/custody-cipher";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const TEST_ORG_ID = "org_dfns_managed";
const TEST_PROJECT_ID = "prj_dfns";

const env: Env = {
  ...testEnv,
  CUSTODY_ENCRYPTION_KEY: TEST_LEGACY_CUSTODY_KEY,
  DFNS_AUTH_TOKEN: "dfns-auth-token",
  DFNS_CREDENTIAL_ID: "dfns-credential-id",
  DFNS_PRIVATE_KEY: "dfns-test-private-key",
  SDP_RELEASE_CHANNEL: "beta",
};

aroundEach((runTest) => inSandboxScope(runTest));

describe("Managed custody config adapters", () => {
  it("builds the adapter named by the config row's provider", async () => {
    const record = createRecord({
      config: await encryptConfig(JSON.stringify({ walletId: "wa_managed_1" })),
    });

    const adapter = await createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record);

    expect(adapter).toBeInstanceOf(KeychainDfnsAdapter);
    expect(adapter.providerId).toBe("dfns");
  });

  it("rejects an encrypted config that is not a JSON object", async () => {
    const record = createRecord({ config: await encryptConfig("not-a-json-config") });

    await expect(createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Custody configuration must be a valid JSON object",
    });
  });

  it("treats anchorage as lifecycle-only (non-signing) configuration", async () => {
    const record: SigningConfigRecord = {
      ...createRecord({
        config: await encryptConfig(JSON.stringify({ apiBaseUrl: "https://example.com" })),
      }),
      provider: "anchorage",
    };

    const adapter = await createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record);

    expect(adapter.providerId).toBe("anchorage");
    expect(isFullSigningPort(adapter)).toBe(false);
  });
});

async function encryptConfig(plaintext: string): Promise<string> {
  const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
  const encrypted = await encryption.encrypt(TEST_ORG_ID, plaintext);
  return encrypted.ciphertext;
}

function createRecord(params: { config: string }): SigningConfigRecord {
  return {
    id: "cust_dfns_managed_test",
    organizationId: TEST_ORG_ID,
    projectId: TEST_PROJECT_ID,
    provider: "dfns",
    config: params.config,
    encryptionVersion: "sdp-custody-encryption-v1",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
