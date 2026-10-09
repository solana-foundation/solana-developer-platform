import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainPrivyAdapter, type SigningConfigRecord } from "@/services/adapters";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import {
  createAdapterFromEncryptedConfig,
  createPrivyAdapterFromCredential,
  type PrivyCredentialAdapterInput,
} from "@/services/domain/signing/provider-adapter-factory";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import type { Env } from "@/types/env";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const ORGANIZATION_ID = "org_factory_release_channel";

const FIREBLOCKS_RECORD: SigningConfigRecord = {
  id: "cust_factory_release_channel",
  organizationId: ORGANIZATION_ID,
  projectId: null,
  provider: "fireblocks",
  config: JSON.stringify({
    provider: "fireblocks",
    apiKey: "fireblocks-api-key",
    apiSecretEncrypted: "fireblocks-sealed-secret",
    vaultAccountId: "vault_factory_release_channel",
    assetId: "SOL_TEST",
  }),
  encryptionVersion: "v2",
  status: "active",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
};

function createEnv(): Env {
  return {
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    SDP_RELEASE_CHANNEL: "stable",
  } as Env;
}

function createRejectingDecrypt() {
  return vi.fn<CustodyCipher["decrypt"]>().mockRejectedValue(new Error("decrypt reached"));
}

function createObservedCredential(read: () => void): PrivyCredentialAdapterInput {
  return {
    get appId() {
      read();
      return "privy-app-factory-release-channel";
    },
    get appSecret() {
      read();
      return "privy-secret-factory-release-channel";
    },
    get walletId() {
      read();
      return "privy-wallet-factory-release-channel";
    },
    requestDelayMs: 0,
  };
}

describe("custody adapter factories and the release channel", () => {
  beforeEach(() => {
    custodyReleaseChannel.outOfChannelMode = null;
  });

  it("refuses a Managed config out of channel before any decrypt", async () => {
    custodyReleaseChannel.outOfChannelMode = "managed";
    const decrypt = createRejectingDecrypt();

    await expect(
      createAdapterFromEncryptedConfig(createEnv(), ORGANIZATION_ID, FIREBLOCKS_RECORD, {
        encrypt: vi.fn<CustodyCipher["encrypt"]>(),
        decrypt,
      })
    ).rejects.toEqual(custodyProviderNotInReleaseChannel("fireblocks", "managed"));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("decrypts a Managed config while only BYOK is out of channel", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";
    const decrypt = createRejectingDecrypt();

    await expect(
      createAdapterFromEncryptedConfig(createEnv(), ORGANIZATION_ID, FIREBLOCKS_RECORD, {
        encrypt: vi.fn<CustodyCipher["encrypt"]>(),
        decrypt,
      })
    ).rejects.toThrow("decrypt reached");
    expect(decrypt).toHaveBeenCalledWith(ORGANIZATION_ID, "fireblocks-sealed-secret");
  });

  it("refuses a BYOK Privy credential out of channel before reading it", () => {
    custodyReleaseChannel.outOfChannelMode = "byok";
    const read = vi.fn();

    expect(() =>
      createPrivyAdapterFromCredential(createEnv(), createObservedCredential(read))
    ).toThrow(custodyProviderNotInReleaseChannel("privy", "byok"));
    expect(read).not.toHaveBeenCalled();
  });

  it("builds a BYOK Privy adapter while only Managed is out of channel", () => {
    custodyReleaseChannel.outOfChannelMode = "managed";
    const read = vi.fn();

    const adapter = createPrivyAdapterFromCredential(createEnv(), createObservedCredential(read));

    expect(adapter).toBeInstanceOf(KeychainPrivyAdapter);
    expect(read).toHaveBeenCalled();
  });
});
