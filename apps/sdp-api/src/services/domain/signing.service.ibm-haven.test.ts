import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { KeychainIbmHavenAdapter, type SigningConfigRecord } from "@/services/adapters";
import {
  type DfnsApiClient,
  IBM_HAVEN_PROVIDER_LABEL,
  resolveDfnsNetwork,
} from "@/services/dfns/client";
import {
  denormalizeIbmHavenWalletId,
  normalizeIbmHavenWalletId,
} from "@/services/domain/signing/provider-wallet-ids";
import { createAdapterFromEncryptedConfig } from "@/services/domain/signing.service";
import { createEncryptionService } from "@/services/encryption.service";
import type { Env } from "@/types/env";

const TEST_ORG_ID = "org_ibm_haven";

describe("signing.service ibm_haven (IBM Digital Asset Haven)", () => {
  it("resolves the IBM Haven adapter with a distinct provider id", async () => {
    const env = createTestEnv();
    const encryptedConfig = await encryptConfig(env, JSON.stringify({ walletId: "wa_haven_1" }));
    const record = createRecord({ config: encryptedConfig, defaultWalletId: null });

    const adapter = await createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record);

    // IBM Haven reuses the Dfns signing stack but must surface as its own provider.
    expect(adapter).toBeInstanceOf(KeychainIbmHavenAdapter);
    expect(adapter.providerId).toBe("ibm_haven");
  });

  it("throws when no default wallet id is configured", async () => {
    const env = createTestEnv();
    const encryptedConfig = await encryptConfig(env, JSON.stringify({}));
    const record = createRecord({ config: encryptedConfig, defaultWalletId: null });

    await expect(createAdapterFromEncryptedConfig(env, TEST_ORG_ID, record)).rejects.toThrow(
      "IBM Digital Asset Haven configuration is missing a default wallet ID"
    );
  });
});

describe("ibm_haven wallet id prefixing", () => {
  it("round-trips the ibmhaven_ prefix and leaves raw / dfns ids untouched", () => {
    expect(normalizeIbmHavenWalletId("wa-1")).toBe("ibmhaven_wa-1");
    expect(normalizeIbmHavenWalletId("ibmhaven_wa-1")).toBe("ibmhaven_wa-1");
    expect(denormalizeIbmHavenWalletId("ibmhaven_wa-1")).toBe("wa-1");
    expect(denormalizeIbmHavenWalletId("wa-1")).toBe("wa-1");
    // Must not strip a dfns_ prefix — that belongs to the Dfns provider.
    expect(denormalizeIbmHavenWalletId("dfns_wa-1")).toBe("dfns_wa-1");
  });

  it("sends the raw (unprefixed) wallet id to the Dfns-shaped API when signing", async () => {
    const requested: string[] = [];
    const adapter = new KeychainIbmHavenAdapter({
      client: createMockDfnsClient(requested),
      defaultWalletId: "wa-default",
    });

    await adapter.getPublicKey("ibmhaven_wa-42");

    // The reused DfnsSigner only strips `dfns_`; the Haven adapter must strip
    // `ibmhaven_` first so the raw id reaches the wire.
    expect(requested).toContain("wa-42");
    expect(requested.some((id) => id.startsWith("ibmhaven_"))).toBe(false);
  });

  it("denormalizes the wallet id on the getTransactionSigner path", async () => {
    const requested: string[] = [];
    const adapter = new KeychainIbmHavenAdapter({
      client: createMockDfnsClient(requested),
      defaultWalletId: "wa-default",
    });

    // This is the path every real signature takes (issuance, transfers).
    await adapter.getTransactionSigner("ibmhaven_wa-42");

    expect(requested).toContain("wa-42");
    expect(requested.some((id) => id.startsWith("ibmhaven_"))).toBe(false);
  });
});

describe("ibm_haven provider labeling", () => {
  it("labels provider errors with the IBM Digital Asset Haven name", () => {
    expect(() => resolveDfnsNetwork("Ethereum", IBM_HAVEN_PROVIDER_LABEL)).toThrow(
      "IBM Digital Asset Haven network must be one of: Solana, SolanaDevnet"
    );
  });
});

function createMockDfnsClient(requested: string[]): DfnsApiClient {
  const address = "So11111111111111111111111111111111111111112";
  return {
    wallets: {
      getWallet: async ({ walletId }: { walletId: string }) => {
        requested.push(walletId);
        return {
          id: walletId,
          address,
          signingKey: { id: "key-haven-1" },
          network: "SolanaDevnet",
        };
      },
      listWallets: async () => ({ items: [] }),
      createWallet: async () => ({ id: "wa-new", address }),
    },
    keySignatures: {
      createSignature: async () => ({ id: "sig-1", status: "Signed" as const }),
      getSignature: async () => ({ id: "sig-1", status: "Signed" as const }),
    },
  } as unknown as DfnsApiClient;
}

function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as DatabaseClient,
    CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    IBM_HAVEN_AUTH_TOKEN: "ibm-haven-auth-token",
    IBM_HAVEN_CREDENTIAL_ID: "ibm-haven-credential-id",
    IBM_HAVEN_PRIVATE_KEY: "ibm-haven-test-private-key",
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
    id: "cust_ibm_haven_test",
    organizationId: TEST_ORG_ID,
    projectId: null,
    provider: "ibm_haven",
    config: params.config,
    defaultWalletId: params.defaultWalletId,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
