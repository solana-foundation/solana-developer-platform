import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { address } from "@solana/kit";
import type { Config, GetPaymentInstructionRequest, KoraClient } from "@solana/kora";
import { KoraAdapter } from "./kora.adapter";

const PAYMENT_ADDRESS = address("AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9");
const USDC_MINT = address(WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"]);
const TOKEN_PROGRAM = address(SPL_TOKEN_PROGRAMS["spl-token"]);

function adapterWithClient(client: Partial<KoraClient>): KoraAdapter {
  return new KoraAdapter({ rpcUrl: "http://localhost:8080", client: client as KoraClient });
}

describe("KoraAdapter.getPricingModel", () => {
  it("reads the pricing model from the server config and caches it", async () => {
    const config = {
      validation_config: { price: { type: "margin", margin: 0 } },
    } as unknown as Config;
    const getConfig = mock.fn(async () => config);
    const adapter = adapterWithClient({ getConfig });

    assert.deepEqual(await adapter.getPricingModel(), { type: "margin", margin: 0 });
    assert.deepEqual(await adapter.getPricingModel(), { type: "margin", margin: 0 });
    assert.equal(getConfig.mock.callCount(), 1);
  });
});

describe("KoraAdapter.getPaymentInstruction", () => {
  it("maps the response and converts payment_amount to bigint", async () => {
    const getPaymentInstruction = mock.fn(async (_request: GetPaymentInstructionRequest) => ({
      payment_instruction: { programAddress: TOKEN_PROGRAM, accounts: [], data: new Uint8Array() },
      payment_amount: 2_039_280,
      payment_token: USDC_MINT,
      payment_address: PAYMENT_ADDRESS,
      signer_address: PAYMENT_ADDRESS,
      original_transaction: "b64",
    }));
    const adapter = adapterWithClient({ getPaymentInstruction });

    const result = await adapter.getPaymentInstruction({
      transaction: new Uint8Array([1, 2, 3]),
      sourceWallet: PAYMENT_ADDRESS,
      feeToken: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });

    assert.equal(result.amountRaw, 2_039_280n);
    assert.equal(result.paymentToken, USDC_MINT);
    assert.equal(result.paymentAddress, PAYMENT_ADDRESS);
    const [request] = getPaymentInstruction.mock.calls[0].arguments;
    assert.equal(request.fee_token, USDC_MINT);
    assert.equal(request.source_wallet, PAYMENT_ADDRESS);
    assert.equal(request.token_program_id, TOKEN_PROGRAM);
  });
});
