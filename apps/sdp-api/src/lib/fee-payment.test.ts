import type { FeePaymentPort } from "@sdp/payments/fee-payment";
import type { RpcEnv } from "@sdp/rpc";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { resolveWalletFeePaymentToken, signMessageWithWalletFeePayment } from "@/lib/fee-payment";
import { TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";

const USDC_DEVNET_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet;

const TEST_ENV: RpcEnv = {
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_TRITON_URL: "http://localhost:8899",
};

function walletWithFeeToken() {
  return { ...TEST_CUSTODY_WALLET, settings: { feePaymentToken: "USDC" as const } };
}

function feePaymentMock(overrides: Partial<FeePaymentPort>): FeePaymentPort {
  return {
    providerId: "kora",
    getFeePayer: vi.fn(),
    signAsFeePayer: vi.fn(),
    signAndSend: vi.fn(),
    getPricingModel: vi.fn().mockResolvedValue({ type: "free" }),
    getPaymentInstruction: vi.fn(),
    ...overrides,
  } as FeePaymentPort;
}

describe("resolveWalletFeePaymentToken", () => {
  it("resolves the configured token to its devnet mint and program", () => {
    const token = resolveWalletFeePaymentToken(TEST_ENV, walletWithFeeToken());
    expect(token.mint).toBe(USDC_DEVNET_MINT);
    expect(token.symbol).toBe("USDC");
    expect(token.decimals).toBe(6);
  });

  it("throws BAD_REQUEST when the wallet has no feePaymentToken", () => {
    let thrown: unknown;
    try {
      resolveWalletFeePaymentToken(TEST_ENV, TEST_CUSTODY_WALLET);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("BAD_REQUEST");
  });
});

describe("signMessageWithWalletFeePayment", () => {
  it("throws when pricing is not free and the wallet has no feePaymentToken", async () => {
    const feePayment = feePaymentMock({
      getPricingModel: vi.fn().mockResolvedValue({ type: "margin", margin: 0 }),
    });
    await expect(
      signMessageWithWalletFeePayment({
        env: TEST_ENV,
        feePayment,
        wallet: TEST_CUSTODY_WALLET,
        sourceAddress: address(TEST_CUSTODY_WALLET.publicKey),
        message: {} as Parameters<typeof signMessageWithWalletFeePayment>[0]["message"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(feePayment.getPaymentInstruction).not.toHaveBeenCalled();
  });
});
