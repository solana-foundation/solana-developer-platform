import { createKoraAdapter } from "@sdp/payments/fee-payment";
import { KoraAdapter } from "@sdp/payments/fee-payment/kora";
import type { KoraClient } from "@solana/kora";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signTransaction = vi.fn();
const signAndSendTransaction = vi.fn();
const getPayerSigner = vi.fn();
const getConfig = vi.fn();
const fakeClient = {
  signTransaction,
  signAndSendTransaction,
  getPayerSigner,
  getConfig,
} as unknown as KoraClient;

const TX = new Uint8Array([1, 2, 3, 4]);
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
  getPayerSigner.mockReset().mockResolvedValue({ signer_address: "FeePayer111" });
  getConfig.mockReset().mockResolvedValue({
    validation_config: {
      max_allowed_lamports: 1_000_000,
      fee_payer_policy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
    },
  });
  signAndSendTransaction.mockReset().mockResolvedValue({
    signature: "TEST_SIGNATURE",
    signed_transaction: "AQIDBA==",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KoraAdapter user_id forwarding", () => {
  it("forwards user_id on signAndSend when configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      userId: "usr_abc123",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    expect(signAndSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "usr_abc123",
        signer_key: "FeePayer111",
        respond_after: "sent",
      })
    );
  });

  it("uses Kora config instead of free-pricing fee estimates", async () => {
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toEqual({
      signerAddress: "FeePayer111",
      maxAllowedLamports: 1_000_000n,
      feePayerMayTransferLamports: false,
      feePayerPolicy: ZERO_OUTFLOW_FEE_PAYER_POLICY,
    });
  });

  it("treats unknown fee-payer policy fields conservatively", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: { max_allowed_lamports: "2000000", fee_payer_policy: {} },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      maxAllowedLamports: 2_000_000n,
      feePayerMayTransferLamports: true,
    });
  });

  it("treats a partial all-false fee-payer policy conservatively", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: { system: { allow_transfer: false } },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      maxAllowedLamports: 2_000_000n,
      feePayerMayTransferLamports: true,
    });
  });

  it("accepts the extended policy shipped by the Kora release running on devnet", async () => {
    const disabled = (...names: string[]) => Object.fromEntries(names.map((name) => [name, false]));
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "10000000",
        fee_payer_policy: {
          system: {
            ...disabled("allow_transfer", "allow_assign", "allow_create_account", "allow_allocate"),
            nonce: disabled(
              "allow_initialize",
              "allow_advance",
              "allow_authorize",
              "allow_withdraw"
            ),
          },
          spl_token: disabled(
            "allow_transfer",
            "allow_burn",
            "allow_close_account",
            "allow_approve",
            "allow_revoke",
            "allow_set_authority",
            "allow_mint_to",
            "allow_initialize_mint",
            "allow_initialize_account",
            "allow_initialize_multisig",
            "allow_freeze_account",
            "allow_thaw_account",
            "allow_unwrap_lamports",
            "allow_withdraw_excess_lamports"
          ),
          token_2022: disabled(
            "allow_transfer",
            "allow_burn",
            "allow_close_account",
            "allow_approve",
            "allow_revoke",
            "allow_set_authority",
            "allow_mint_to",
            "allow_initialize_mint",
            "allow_initialize_account",
            "allow_initialize_multisig",
            "allow_freeze_account",
            "allow_thaw_account",
            "allow_unwrap_lamports",
            "allow_withdraw_excess_lamports",
            "allow_initialize_extension_authority",
            "allow_update_extension_authority"
          ),
          alt: disabled(
            "allow_close",
            "allow_create",
            "allow_deactivate",
            "allow_extend",
            "allow_freeze"
          ),
          bpf_loader_upgradeable: disabled(
            "allow_close",
            "allow_deploy_with_max_data_len",
            "allow_extend_program",
            "allow_extend_program_checked",
            "allow_initialize_buffer",
            "allow_migrate",
            "allow_set_authority",
            "allow_set_authority_checked",
            "allow_upgrade",
            "allow_write"
          ),
          loader_v4: disabled(
            "allow_copy",
            "allow_deploy",
            "allow_finalize",
            "allow_retract",
            "allow_set_program_length",
            "allow_transfer_authority",
            "allow_write"
          ),
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: false,
    });
  });

  it("accepts an authority Kora added since this code was written, when it is disabled", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          loader_v4: { allow_write: false, allow_deploy: false },
          unexpected_authority: false,
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: false,
    });
  });

  it("rejects an authority Kora added since this code was written, when it is enabled", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          loader_v4: { allow_write: false, allow_deploy: true },
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it("rejects a policy whose authorities live on the prototype rather than the object", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: Object.create(ZERO_OUTFLOW_FEE_PAYER_POLICY),
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it("rejects a policy hiding an enabled authority behind a non-enumerable key", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          loader_v4: Object.defineProperty({}, "allow_write", {
            value: true,
            enumerable: false,
          }),
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it("rejects a policy whose authority group is not a plain object", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          loader_v4: new Map([["allow_write", true]]),
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it("treats a non-boolean policy leaf conservatively", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          spl_token: {
            ...ZERO_OUTFLOW_FEE_PAYER_POLICY.spl_token,
            allow_burn: "false",
          },
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it("treats any enabled authority conservatively", async () => {
    getConfig.mockResolvedValueOnce({
      validation_config: {
        max_allowed_lamports: "2000000",
        fee_payer_policy: {
          ...ZERO_OUTFLOW_FEE_PAYER_POLICY,
          system: {
            ...ZERO_OUTFLOW_FEE_PAYER_POLICY.system,
            nonce: {
              ...ZERO_OUTFLOW_FEE_PAYER_POLICY.system.nonce,
              allow_withdraw: true,
            },
          },
        },
      },
    });
    const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
    await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
      feePayerMayTransferLamports: true,
    });
  });

  it.each([undefined, null])(
    "treats a nullish fee-payer policy conservatively (%s)",
    async (feePayerPolicy) => {
      getConfig.mockResolvedValueOnce({
        validation_config: {
          max_allowed_lamports: "2000000",
          fee_payer_policy: feePayerPolicy,
        },
      });
      const adapter = new KoraAdapter({ rpcUrl: "http://kora", client: fakeClient });
      await expect(adapter.getSponsorshipConfiguration()).resolves.toMatchObject({
        maxAllowedLamports: 2_000_000n,
        feePayerMayTransferLamports: true,
      });
    }
  );

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

  it("uses a fail-closed user_id on signAndSend when no scoped identity is configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAndSend(TX);
    const arg = signAndSendTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).toHaveProperty("user_id", "sdp:unscoped");
    expect(arg).toHaveProperty("transaction");
  });

  it("uses a fail-closed user_id on signAsFeePayer when no scoped identity is configured", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "http://kora",
      client: fakeClient,
    });
    await adapter.signAsFeePayer(TX);
    const arg = signTransaction.mock.calls[0]?.[0] ?? {};
    expect(arg).toHaveProperty("user_id", "sdp:unscoped");
    expect(arg).toHaveProperty("transaction");
  });

  it("adds a Cloud Run service identity while preserving Kora API-key auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("header.e30.signature"))
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signer_address: "FeePayer111" },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { signed_transaction: "AQIDBA==" },
        })
      );
    const adapter = createKoraAdapter(
      {
        FEE_PAYMENT_PROVIDER: "kora",
        KORA_RPC_URL: "https://private-kora.example",
        KORA_API_KEY: "kora-api-key",
        KORA_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
      },
      "sdp:v1:production:org:project:user:actor"
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
      createKoraAdapter(
        {
          FEE_PAYMENT_PROVIDER: "kora",
          KORA_RPC_URL: "https://kora-devnet.solana.com",
          KORA_CLOUD_RUN_AUDIENCE: "https://private-kora.example",
        },
        "sdp:v1:production:org:organization:api_key:key"
      )
    ).toThrow("KORA_RPC_URL must use HTTPS and match the KORA_CLOUD_RUN_AUDIENCE origin");
  });

  it("rejects sending a Cloud Run identity token over HTTP", () => {
    expect(
      () =>
        new KoraAdapter({
          rpcUrl: "http://private-kora.example",
          identityTokenAudience: "http://private-kora.example",
          userId: "sdp:v1:production:org:organization:api_key:key",
        })
    ).toThrow("KORA_RPC_URL must use HTTPS and match the KORA_CLOUD_RUN_AUDIENCE origin");
  });
});
