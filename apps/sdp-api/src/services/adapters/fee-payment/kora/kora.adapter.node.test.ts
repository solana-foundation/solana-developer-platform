import { createKoraAdapter } from "@sdp/fee-payment";
import { KoraAdapter } from "@sdp/fee-payment/kora.adapter";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { KoraClient } from "@solana/kora";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

const signTransaction = vi.fn();
const getPayerSigner = vi.fn();
const getConfig = vi.fn();
const fakeClient = {
  signTransaction,
  getPayerSigner,
  getConfig,
} as unknown as KoraClient;

const TX = new Uint8Array([1, 2, 3, 4]);

function scopedKoraAdapter(): KoraAdapter {
  return new KoraAdapter({
    rpcUrl: "http://kora",
    userId: "sdp:v1:sandbox:org_1:project:project_1:api_key:key_1",
    client: fakeClient,
  });
}
const ZERO_OUTFLOW_FEE_PAYER_POLICY = {
  system: {
    allow_transfer: false,
    allow_assign: false,
    allow_create_account: false,
    allow_allocate: false,
    nonce: {
      allow_initialize: false,
      allow_advance: false,
      allow_authorize: false,
      allow_withdraw: false,
    },
  },
  spl_token: {
    allow_transfer: false,
    allow_burn: false,
    allow_close_account: false,
    allow_approve: false,
    allow_revoke: false,
    allow_set_authority: false,
    allow_mint_to: false,
    allow_initialize_mint: false,
    allow_initialize_account: false,
    allow_initialize_multisig: false,
    allow_freeze_account: false,
    allow_thaw_account: false,
  },
  token_2022: {
    allow_transfer: false,
    allow_burn: false,
    allow_close_account: false,
    allow_approve: false,
    allow_revoke: false,
    allow_set_authority: false,
    allow_mint_to: false,
    allow_initialize_mint: false,
    allow_initialize_account: false,
    allow_initialize_multisig: false,
    allow_freeze_account: false,
    allow_thaw_account: false,
  },
} as const;

beforeEach(() => {
  signTransaction.mockReset().mockResolvedValue({ signed_transaction: "AQIDBA==" });
  getPayerSigner.mockReset().mockResolvedValue({ signer_address: TEST_MOCK_FEE_PAYER });
  getConfig.mockReset().mockResolvedValue({
    validation_config: {
      max_allowed_lamports: 1_000_000,
      fee_payer_policy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KoraAdapter user_id forwarding", () => {
  it("uses Kora config instead of free-pricing fee estimates", async () => {
    const adapter = scopedKoraAdapter();
    await expect(adapter.getSponsorshipConfiguration()).resolves.toEqual({
      signerAddress: TEST_MOCK_FEE_PAYER,
      maxAllowedLamports: 1_000_000n,
      feePayerPolicy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
    });
  });

  it("forwards user_id on signAsFeePayer when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    expect(signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "usr_abc123" })
    );
  });

  it("adds a Cloud Run service identity while preserving Kora API-key auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("header.e30.signature"))
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signer_address: TEST_MOCK_FEE_PAYER },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signed_transaction: "AQIDBA==" },
        })
      );
    const adapter = runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      createKoraAdapter(
        {
          KORA_DEVNET_URL: "https://private-kora.example",
          KORA_DEVNET_API_KEY: "kora-api-key",
          KORA_DEVNET_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
        },
        "sdp:v1:production:org:project:user:actor"
      )
    );

    await adapter.signAsFeePayer(TX);

    const metadataUrl = fetchMock.mock.calls[0]?.[0];
    expect(metadataUrl).toBeInstanceOf(URL);
    expect(String(metadataUrl)).toContain("audience=https%3A%2F%2Fprivate-kora.example");
    const rpcRequest = fetchMock.mock.calls[2]?.[1];
    expect(rpcRequest?.headers).toMatchObject({
      Authorization: "Bearer header.e30.signature",
      "x-api-key": "kora-api-key",
    });
    expect(JSON.parse(String(rpcRequest?.body))).toMatchObject({
      method: "signTransaction",
      params: { user_id: "sdp:v1:production:org:project:user:actor" },
    });
  });

  it("rejects a Cloud Run identity audience that does not match the Kora origin", () => {
    expect(() =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        createKoraAdapter(
          {
            KORA_DEVNET_URL: "https://kora-devnet.mock.invalid",
            KORA_DEVNET_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
          },
          "sdp:v1:production:org:project:prj:api_key:key"
        )
      )
    ).toThrow(
      "KORA_<CLUSTER>_URL must use HTTPS and match the KORA_<CLUSTER>_CLOUD_RUN_AUDIENCE origin"
    );
  });

  it("rejects sending a Cloud Run identity token over HTTP", () => {
    expect(
      () =>
        new KoraAdapter({
          rpcUrl: "http://private-kora.example",
          identityTokenAudience: "http://private-kora.example",
          userId: "sdp:v1:production:org:project:prj:api_key:key",
        })
    ).toThrow(
      "KORA_<CLUSTER>_URL must use HTTPS and match the KORA_<CLUSTER>_CLOUD_RUN_AUDIENCE origin"
    );
  });
});
