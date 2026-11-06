import { KeychainPrivyAdapter } from "@sdp/custody/keychain/keychain-privy.adapter";
import { type FullSigningPort, isFullSigningPort, type SigningPort } from "@sdp/custody/signing";
import type { CustodyMode } from "@sdp/types/custody";
import { SignerErrorCode } from "@solana/keychain-core";
import {
  createSignableMessage,
  getBase64Decoder,
  isMessagePartialSigner,
  signBytes,
} from "@solana/kit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as events from "@/runtime/money-path-events";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import {
  createAdapterFromEncryptedConfig,
  createFireblocksAdapterFromCredential,
  createPrivyAdapterFromCredential,
  type PrivyCredentialAdapterInput,
} from "@/services/domain/signing/provider-adapter-factory";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { TEST_MOCK_FEE_PAYER, TEST_MOCK_FEE_PAYER_KEY_PAIR } from "@/test/helpers/sponsor-signing";
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
  projectId: "prj_factory_release_channel",
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
    SDP_RELEASE_CHANNEL: "beta",
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

const PRIVY_WALLET_ID = "privy-wallet-factory-release-channel";
const SIGNED_CONTENT = new Uint8Array([1, 2, 3]);
const BYOK_PRIVY_SIGN_MESSAGES_CALL = {
  event: "sdp_api_vendor_call",
  vendor: "privy",
  operation: "signMessages",
  boundary: "adapter_operation",
  custody_mode: "byok",
  cluster: "devnet",
} as const;

function createByokPrivyPort(): FullSigningPort {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ address: TEST_MOCK_FEE_PAYER, chain_type: "solana" })
  );
  const port = inSandboxScope(() =>
    createPrivyAdapterFromCredential(createEnv(), createObservedCredential(vi.fn()))
  );
  assert(isFullSigningPort(port));
  return port;
}

async function signMessageWithByokPrivy(signResponse: Response) {
  const port = createByokPrivyPort();
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(signResponse);
  const signer = await port.getTransactionSigner(PRIVY_WALLET_ID);
  assert(isMessagePartialSigner(signer));
  return signer.signMessages([createSignableMessage(SIGNED_CONTENT)]);
}

describe("custody adapter factories and the release channel", () => {
  beforeEach(() => {
    custodyReleaseChannel.outOfChannelMode = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("refuses a BYOK Fireblocks credential out of channel before reading it", () => {
    custodyReleaseChannel.outOfChannelMode = "byok";
    const read = vi.fn(() => "must not be read");
    const input = {
      get apiKey() {
        return read();
      },
      get apiSecretPem() {
        return read();
      },
      get walletId() {
        return read();
      },
      assetId: "SOL_TEST" as const,
    };

    expect(() => createFireblocksAdapterFromCredential(createEnv(), input)).toThrow(
      custodyProviderNotInReleaseChannel("fireblocks", "byok")
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("builds a BYOK Privy adapter while only Managed is out of channel", () => {
    custodyReleaseChannel.outOfChannelMode = "managed";
    const read = vi.fn();

    const adapter = inSandboxScope(() =>
      createPrivyAdapterFromCredential(createEnv(), createObservedCredential(read))
    );

    expect(adapter).toBeInstanceOf(KeychainPrivyAdapter);
    expect(read).toHaveBeenCalled();
  });

  it.each<[CustodyMode, () => Promise<SigningPort>]>([
    [
      "byok",
      async () => createPrivyAdapterFromCredential(createEnv(), createObservedCredential(vi.fn())),
    ],
    [
      "managed",
      () =>
        createAdapterFromEncryptedConfig(
          {
            ...createEnv(),
            PRIVY_APP_ID: "privy-app-factory-managed",
            PRIVY_APP_SECRET: "privy-secret-factory-managed",
          },
          ORGANIZATION_ID,
          {
            ...FIREBLOCKS_RECORD,
            provider: "privy",
            config: JSON.stringify({ provider: "privy" }),
          },
          { encrypt: vi.fn<CustodyCipher["encrypt"]>(), decrypt: createRejectingDecrypt() }
        ),
    ],
  ])("logs a %s Privy adapter's calls with its custody mode and cluster", async (mode, build) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ address: "11111111111111111111111111111111", chain_type: "solana" })
    );
    const logEvent = vi.spyOn(events, "logEvent");

    await inSandboxScope(async () =>
      (await build()).getPublicKey("privy-wallet-factory-release-channel")
    );

    expect(logEvent).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_vendor_call",
        vendor: "privy",
        operation: "getPublicKey",
        outcome: "succeeded",
        custody_mode: mode,
        cluster: "devnet",
      })
    );
  });

  it("logs a BYOK Privy signer's signMessages with its custody mode and cluster", async () => {
    const signature = await signBytes(TEST_MOCK_FEE_PAYER_KEY_PAIR.privateKey, SIGNED_CONTENT);
    const logEvent = vi.spyOn(events, "logEvent");

    await expect(
      signMessageWithByokPrivy(
        Response.json({ data: { signature: getBase64Decoder().decode(signature) } })
      )
    ).resolves.toEqual([{ [TEST_MOCK_FEE_PAYER]: signature }]);
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({ ...BYOK_PRIVY_SIGN_MESSAGES_CALL, outcome: "succeeded" })
    );
  });

  it("logs a BYOK Privy signer's failed signMessages and rejects with the provider error", async () => {
    const logEvent = vi.spyOn(events, "logEvent");

    await expect(
      signMessageWithByokPrivy(new Response("unavailable", { status: 503 }))
    ).rejects.toMatchObject({
      name: "SignerError",
      code: SignerErrorCode.REMOTE_API_ERROR,
      context: expect.objectContaining({ status: 503 }),
    });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        ...BYOK_PRIVY_SIGN_MESSAGES_CALL,
        outcome: "failed",
        error_name: "SignerError",
        error_code: SignerErrorCode.REMOTE_API_ERROR,
      })
    );
  });

  it("hands out one instrumented signer per BYOK Privy wallet", async () => {
    const port = createByokPrivyPort();

    const signer = await port.getTransactionSigner(PRIVY_WALLET_ID);

    expect(await port.getTransactionSigner(PRIVY_WALLET_ID)).toBe(signer);
  });
});
