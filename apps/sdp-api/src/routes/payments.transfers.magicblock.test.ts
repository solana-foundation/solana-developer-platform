import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import { SOL_MINT } from "@sdp/types";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  createRpcMock,
  DEVNET_USDC_MINT,
  fullySignTestTransaction,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  mockTokenSupplyDecimalsOnce,
  sendAndConfirmTransactionMock,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_WALLET_ID,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  listTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
  seedCustodyWalletFixture,
  seedSelectedApiKeyWalletBindings,
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";

const TEST_ADDITIONAL_CUSTODY_WALLET_ID = "cwlt_payments_additional_test";

const TEST_ADDITIONAL_WALLET_ID = "wal_payments_additional_test";

const TEST_DUPLICATE_CUSTODY_WALLET_ID = "cwlt_payments_duplicate_test";

const TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID = "cwlt_payments_alias_authorized_test";

const TEST_MAGICBLOCK_API_BASE_URL = "https://payments.magicblock.test";

const TEST_MAGICBLOCK_SPONSOR_FEE_PAYER = "CrankS2fXgMGvQJ3VBrZmRfGrfogDY6pq5YcgkPEpSNf";

const approvalErrorDetailsSchema = z.object({
  approvalRequestId: z.string(),
  walletOperationId: z.string(),
});

function readMockCall<T extends unknown[]>(calls: T[], index: number): T {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`Mock call ${index} was not recorded`);
  }
  return call;
}

function buildMagicBlockTestTransactionBase64(params?: {
  feePayer?: string;
  source?: string;
  destination?: string;
  additionalSigner?: string;
}): string {
  const sourceValue = params?.source === undefined ? TEST_SOLANA_ADDRESSES.wallet1 : params.source;
  const feePayerValue = params?.feePayer === undefined ? sourceValue : params.feePayer;
  const destinationValue =
    params?.destination === undefined ? TEST_SOLANA_ADDRESSES.wallet2 : params.destination;
  const feePayer = address(feePayerValue);
  const source = address(sourceValue);
  const destination = address(destinationValue);
  const instructions = [
    getTransferSolInstruction({
      source: createNoopSigner(source),
      destination,
      amount: 1n,
    }),
  ];

  if (params?.additionalSigner) {
    instructions.push(
      getTransferSolInstruction({
        source: createNoopSigner(address(params.additionalSigner)),
        destination: source,
        amount: 1n,
      })
    );
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Parameters<
            typeof setTransactionMessageLifetimeUsingBlockhash
          >[0]["blockhash"],
          lastValidBlockHeight: 1000n,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function mockMagicBlockAdditionalSignerResponse(
  sourceAddress: string,
  additionalSignerAddress: string
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        kind: "transfer",
        version: "v0",
        transactionBase64: buildMagicBlockTestTransactionBase64({
          source: sourceAddress,
          additionalSigner: additionalSignerAddress,
        }),
        sendTo: "base",
        recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
        lastValidBlockHeight: 123456,
        instructionCount: 4,
        requiredSigners: [sourceAddress, additionalSignerAddress],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )
  );
}

async function _seedExactIdProviderAliasWallet(): Promise<void> {
  const configId = "cust_cfg_payments_alias_authorized_test";
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', ?, 'active')`
      )
      .bind(configId, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, 'Alias-authorized wallet', 'transfer', 'active')`
      )
      .bind(
        TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        configId,
        TEST_CUSTODY_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1
      ),
  ]);
}

describe("Payments routes — MagicBlock transfers", () => {
  installPaymentsRouteTestHooks();
  describe("execute transfer — happy path", () => {
    it("rejects MagicBlock execution when gasless sponsorship is explicitly disabled", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: {
              provider: "magicblock",
              magicBlock: {
                gasless: false,
              },
            },
          },
          {}
        );

        expect(res.status).toBe(400);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toContain("requires gasless transactions");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("executes a MagicBlock private transfer that settles to base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerForCustodyWalletMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: {
              provider: "magicblock",
              magicBlock: {
                split: 2,
                minDelayMs: "0",
                maxDelayMs: "1000",
              },
            },
          },
          {}
        );

        expect(res.status).toBe(200);
        const body = await readTransferResponse(res);
        expect(body.data.transfer).toMatchObject({
          status: "confirmed",
          type: "transfer_confidential",
        });
        expect(body.data.transfer.signature).toBeTruthy();
        expect(body.data.privateTransfer?.magicBlock).toMatchObject({
          kind: "transfer",
          version: "v0",
        });
        expect(signAndSendMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).toHaveBeenCalledOnce();
        expect(sendAndConfirmTransactionMock).not.toHaveBeenCalled();
        const stored = await readTransferRow(body.data.transfer.id);
        expect(stored.signed_transaction).toBeTruthy();
        expect(stored.signed_transaction).not.toBe(body.data.transfer.serializedTx);
        expect(stored.last_valid_block_height).toBe("1000");
        expect(stored?.submission_started_at).not.toBeNull();
        expect(getRecentBlockhashMock).toHaveBeenCalledWith(expect.anything(), "confirmed");
        const [, init] = readMockCall(fetchSpy.mock.calls, 0);
        const providerPayload = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(String(init?.body)));
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          split: 2,
          minDelayMs: "0",
          maxDelayMs: "1000",
          gasless: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    describe("hostile MagicBlock responses", () => {
      async function requestWithProviderResponse(
        buildResponse: (sourceSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>) => object
      ) {
        env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
        const sourceSigner = await generateKeyPairSigner();
        await updateSeededWalletPublicKey(sourceSigner.address);
        createRpcMock.mockReturnValue({
          getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
          getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
        } as unknown as ReturnType<typeof solanaRpc.createRpc>);
        createOrgSignerForCustodyWalletMock.mockResolvedValue(sourceSigner);
        createFeePaymentAdapterMock.mockReturnValue({
          providerId: "mock",
          getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
          getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
          signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
          signAndSend: vi.fn(),
        } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify(buildResponse(sourceSigner)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
        try {
          return await postTransfer(
            {
              sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: { provider: "magicblock", magicBlock: {} },
            },
            {}
          );
        } finally {
          fetchSpy.mockRestore();
        }
      }

      function honestResponse(sourceAddress: string) {
        return {
          kind: "transfer",
          version: "v0",
          transactionBase64: buildMagicBlockTestTransactionBase64({ source: sourceAddress }),
          sendTo: "base",
          recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
          lastValidBlockHeight: 123456,
          instructionCount: 3,
          requiredSigners: [sourceAddress],
        };
      }
      it("refuses bytes whose signers differ from the declared required signers", async () => {
        const response = await requestWithProviderResponse((sourceSigner) => ({
          ...honestResponse(sourceSigner.address),
          transactionBase64: buildMagicBlockTestTransactionBase64({
            source: sourceSigner.address,
            additionalSigner: TEST_SOLANA_ADDRESSES.wallet3,
          }),
        }));

        expect(response.status).toBe(503);
        expect(sendTransactionMock).not.toHaveBeenCalled();
      });
      it("refuses a declared signer the transaction does not require", async () => {
        const response = await requestWithProviderResponse((sourceSigner) => ({
          ...honestResponse(sourceSigner.address),
          requiredSigners: [sourceSigner.address, TEST_SOLANA_ADDRESSES.wallet3],
        }));

        expect(response.status).toBe(503);
        expect(sendTransactionMock).not.toHaveBeenCalled();
      });
      it("refuses bytes whose blockhash differs from the declared one", async () => {
        const response = await requestWithProviderResponse((sourceSigner) => ({
          ...honestResponse(sourceSigner.address),
          recentBlockhash: "11111111111111111111111111111111",
        }));

        expect(response.status).toBe(503);
        expect(sendTransactionMock).not.toHaveBeenCalled();
      });

      it("refuses a declared version the bytes do not carry", async () => {
        const response = await requestWithProviderResponse((sourceSigner) => ({
          ...honestResponse(sourceSigner.address),
          version: "legacy",
        }));

        expect(response.status).toBe(503);
        expect(sendTransactionMock).not.toHaveBeenCalled();
      });
      it("refuses a transaction the requested source wallet does not sign", async () => {
        const response = await requestWithProviderResponse((sourceSigner) => {
          void sourceSigner;
          return {
            ...honestResponse(TEST_SOLANA_ADDRESSES.wallet3),
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: TEST_SOLANA_ADDRESSES.wallet3,
            }),
          };
        });
        expect(response.status).toBe(503);
        expect(sendTransactionMock).not.toHaveBeenCalled();
      });
    });

    it("does not re-run MagicBlock preparation on an idempotent replay", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerForCustodyWalletMock.mockResolvedValue(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-replay-key",
        };
        const body = JSON.stringify({
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });

        const first = await postTransfer(JSON.parse(body), {
          idempotencyKey: headers["Idempotency-Key"],
        });
        const second = await postTransfer(JSON.parse(body), {
          idempotencyKey: headers["Idempotency-Key"],
        });

        expect(first.status, await first.clone().text()).toBe(200);
        expect(second.status).toBe(200);
        const firstBody = await readTransferResponse(first);
        const secondBody = await readTransferResponse(second);
        expect(secondBody.data.transfer.id).toBe(firstBody.data.transfer.id);
        expect(secondBody.data.privateTransfer).toEqual(firstBody.data.privateTransfer);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(signAndSendMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).toHaveBeenCalledOnce();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects a confidential replay when magicBlock options differ", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerForCustodyWalletMock.mockResolvedValue(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-opts-key",
        };
        const bodyA = JSON.stringify({
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const bodyB = JSON.stringify({
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 3, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const first = await postTransfer(JSON.parse(bodyA), {
          idempotencyKey: headers["Idempotency-Key"],
        });
        const conflict = await postTransfer(JSON.parse(bodyB), {
          idempotencyKey: headers["Idempotency-Key"],
        });
        expect(first.status).toBe(200);
        expect(conflict.status).toBe(409);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("replaces a MagicBlock gasless sponsor signer with Kora during execution", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerForCustodyWalletMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              feePayer: TEST_MAGICBLOCK_SPONSOR_FEE_PAYER,
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 5,
            requiredSigners: [TEST_MAGICBLOCK_SPONSOR_FEE_PAYER, sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "5",
            privateTransfer: {
              provider: "magicblock",
              magicBlock: {},
            },
          },
          {}
        );

        expect(res.status, await res.clone().text()).toBe(200);
        expect(signAndSendMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).toHaveBeenCalledOnce();
        const [, encodedTransaction] = readMockCall(sendTransactionMock.mock.calls, 0);
        const transaction = getTransactionDecoder().decode(encodedTransaction as Uint8Array);
        const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        expect(message.staticAccounts[0]).toBe(TEST_KORA_FEE_PAYER);
        expect(message.staticAccounts[1]).toBe(sourceSigner.address);
        expect(message.staticAccounts).not.toContain(TEST_MAGICBLOCK_SPONSOR_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(TEST_KORA_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(sourceSigner.address);
        expect(Object.keys(transaction.signatures)).not.toContain(
          TEST_MAGICBLOCK_SPONSOR_FEE_PAYER
        );
        const [, init] = readMockCall(fetchSpy.mock.calls, 0);
        const providerPayload = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(String(init?.body)));
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          gasless: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an additional custody signer outside the API key wallet authorization boundary", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      mockTokenSupplyDecimalsOnce();
      createOrgSignerForCustodyWalletMock.mockImplementation(
        async (_env, _organizationId, _projectId, custodyWalletId) =>
          custodyWalletId === TEST_ADDITIONAL_CUSTODY_WALLET_ID ? additionalSigner : sourceSigner
      );

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );

        expect(res.status).toBe(403);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toContain("not authorized for the requested wallet");
        expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an ambiguous additional signer address before creating a transfer", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedCustodyWalletFixture({
        id: TEST_DUPLICATE_CUSTODY_WALLET_ID,
        walletId: "wal_payments_duplicate_test",
        publicKey: additionalSigner.address,
        label: "Duplicate Payments Wallet",
      });
      mockTokenSupplyDecimalsOnce();
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );

        expect(res.status).toBe(409);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toContain("additional signer is ambiguous");
        expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).not.toHaveBeenCalled();
        expect(await countTransferRows()).toBe(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects approval-required additional signers before creating a transfer", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-signer-approval",
            kind: "approval",
            operationTypes: ["payment_transfer_execute"],
            action: "approval_required",
          },
        ],
      });
      mockTokenSupplyDecimalsOnce();
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );

        expect(res.status).toBe(409);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe(
          "MagicBlock additional signer requires policy approval, but multi-wallet approval replay is not supported"
        );
        expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).not.toHaveBeenCalled();
        expect(await countTransferRows()).toBe(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("signs with every custody signer authorized for the API key and transfer policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-destination-allowlist",
            kind: "destination",
            allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
            action: "allow",
          },
        ],
      });
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
        {
          walletId: TEST_ADDITIONAL_WALLET_ID,
          custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      mockTokenSupplyDecimalsOnce();
      createOrgSignerForCustodyWalletMock.mockImplementation(
        async (_env, _organizationId, _projectId, custodyWalletId) =>
          custodyWalletId === TEST_ADDITIONAL_CUSTODY_WALLET_ID ? additionalSigner : sourceSigner
      );
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );

        expect(res.status).toBe(200);
        expect(createOrgSignerForCustodyWalletMock.mock.calls.map((call) => call[3])).toEqual([
          TEST_CUSTODY_WALLET_ID,
          TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        ]);
        expect(signAndSendMock).not.toHaveBeenCalled();
        expect(sendTransactionMock).toHaveBeenCalledOnce();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("executes an approved MagicBlock source with allowed additional signers", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedWalletControlProfile({
        rules: [
          {
            id: "source-approval",
            kind: "approval",
            operationTypes: ["payment_transfer_execute"],
            action: "approval_required",
          },
        ],
      });
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-signer-allow",
            kind: "destination",
            allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
            action: "allow",
          },
        ],
      });
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
        {
          walletId: TEST_ADDITIONAL_WALLET_ID,
          custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      mockTokenSupplyDecimalsOnce();
      createOrgSignerForCustodyWalletMock.mockImplementation(
        async (_env, _organizationId, _projectId, custodyWalletId) =>
          custodyWalletId === TEST_ADDITIONAL_CUSTODY_WALLET_ID ? additionalSigner : sourceSigner
      );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
        signAndSend: vi.fn(),
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const pendingResponse = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );
        expect(pendingResponse.status).toBe(202);
        expect(fetchSpy).not.toHaveBeenCalled();
        const pendingBody = await readErrorResponse(pendingResponse);
        const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
          pendingBody.error.details
        );
        const repository = createPostgresPolicyRepository(
          getDb(env),
          createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
        );
        await repository.updateApprovalRequestStatus({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          approvalRequestId,
          status: "approved",
          operationStatus: "executing",
          resolvedBy: TEST_API_KEY.id,
        });

        expect(await recoverApprovedWalletOperations(env)).toBe(1);
        expect(await repository.getWalletOperationById(walletOperationId)).toMatchObject({
          status: "completed",
          execution_error: null,
        });
        expect(createOrgSignerForCustodyWalletMock.mock.calls.map((call) => call[3])).toEqual([
          TEST_CUSTODY_WALLET_ID,
          TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        ]);
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(sendTransactionMock).toHaveBeenCalledOnce();
        const transfers = await listTransferRows();
        expect(transfers).toHaveLength(1);
        expect(transfers[0]).toMatchObject({
          custody_wallet_id: TEST_CUSTODY_WALLET_ID,
          status: "confirmed",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an authorized additional custody signer denied by its wallet policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCustodyWalletFixture({
        id: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        walletId: TEST_ADDITIONAL_WALLET_ID,
        publicKey: additionalSigner.address,
        label: "Additional Payments Wallet",
      });
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-destination-allowlist",
            kind: "destination",
            allowlist: [TEST_SOLANA_ADDRESSES.wallet3],
            action: "allow",
          },
        ],
      });
      await seedSelectedApiKeyWalletBindings([
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
        {
          walletId: TEST_ADDITIONAL_WALLET_ID,
          custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
          permissions: ["payments:write"],
        },
      ]);
      mockTokenSupplyDecimalsOnce();
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: { provider: "magicblock", magicBlock: {} },
          },
          {}
        );

        expect(res.status).toBe(403);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Wallet operation denied by policy");
        const details = z
          .object({ decision: z.string(), reason: z.string() })
          .parse(body.error.details);
        expect(details.decision).toBe("deny");
        expect(details.reason).toContain(
          `Destination ${TEST_SOLANA_ADDRESSES.wallet2} is not allowed by policy.`
        );
        expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects MagicBlock execution responses routed outside base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "ephemeral",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await postTransfer(
          {
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
            privateTransfer: {
              provider: "magicblock",
              magicBlock: {},
            },
          },
          {}
        );

        expect(res.status).toBe(503);
        const body = await readErrorResponse(res);
        expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
        expect(body.error.message).toBe(
          "MagicBlock returned a non-base submission target, which this SDP route does not support."
        );
        const [, init] = readMockCall(fetchSpy.mock.calls, 0);
        const providerPayload = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(String(init?.body)));
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          to: TEST_SOLANA_ADDRESSES.wallet2,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("blocks a transfer denied by an active wallet control profile before signing", async () => {
      await seedWalletControlProfile({
        rules: [{ id: "small-transfer-only", kind: "amount", max: "0.5", asset: SOL_MINT }],
      });

      const res = await postTransfer(
        {
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "1",
        },
        {}
      );

      expect(res.status).toBe(403);
      const body = await readErrorResponse(res);
      expect(body.error.code).toBe("FORBIDDEN");
      const details = z
        .object({
          decision: z.string(),
          walletOperationId: z.string(),
          policyEvaluationId: z.string(),
        })
        .parse(body.error.details);
      expect(details).toMatchObject({
        decision: "deny",
      });
      expect(details.walletOperationId).toMatch(/^wop_/);
      expect(details.policyEvaluationId).toMatch(/^peval_/);
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();

      const operation = await getDb(env)
        .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
        .first<{ status: string; operation_family: string; operation_type: string }>();
      expect(operation).toMatchObject({
        status: "failed",
        operation_family: "payment",
        operation_type: "payment_transfer_execute",
      });

      const evaluation = await getDb(env)
        .prepare("SELECT decision FROM policy_evaluations")
        .first<{ decision: string }>();
      expect(evaluation?.decision).toBe("deny");

      expect(await countTransferRows()).toBe(0);
    });
  });
});
