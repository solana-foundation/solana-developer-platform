import * as RpcModule from "@sdp/rpc/solana";
import { MosaicAmountError } from "@sdp/solana/mosaic-amount";
import * as ReadTokenTerms from "@sdp/solana/read-token-terms";
import { type SponsoredSubmitter, Token2022Service } from "@sdp/solana/token-2022";
import { parseTokenAmount } from "@sdp/solana/token-amount";
import * as Kit from "@solana/kit";
import * as MosaicSdk from "@solana/mosaic-sdk";
import { getBurnCheckedInstruction } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintTermsAt } from "@/test/helpers/token-movement";

const env = { SOLANA_RPC_URL: "http://localhost:8899", SOLANA_NETWORK: "devnet" } as const;
const lifetime = {
  blockhash: Kit.blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
};
const signature = Kit.signature("1".repeat(64));
const amount = parseTokenAmount("1.25", 6);

// Namespace spies rely on mosaic-sdk being in server.deps.inline in vitest.config.ts.
describe("Token2022Service burn", () => {
  let authority: Kit.KeyPairSigner;
  let mint: Kit.Address;
  let tokenAccount: Kit.Address;
  let sponsor: Kit.Address;
  let feePayment: SponsoredSubmitter;
  const send = vi.fn().mockResolvedValue(signature);
  const sendTransaction = vi.fn<
    (
      wireTransaction: Kit.Base64EncodedWireTransaction,
      config: { skipPreflight: boolean; encoding: "base64"; maxRetries?: bigint }
    ) => { send: typeof send }
  >(() => ({ send }));
  const rpc = { sendTransaction } as unknown as ReturnType<typeof RpcModule.createRpcForSdk>;

  beforeEach(async () => {
    authority = await Kit.generateKeyPairSigner();
    mint = (await Kit.generateKeyPairSigner()).address;
    tokenAccount = (await Kit.generateKeyPairSigner()).address;
    sponsor = (await Kit.generateKeyPairSigner()).address;
    feePayment = {
      getFeePayer: vi.fn<SponsoredSubmitter["getFeePayer"]>().mockResolvedValue(sponsor),
      submitSponsored: vi.fn<SponsoredSubmitter["submitSponsored"]>().mockResolvedValue(signature),
    };
    // Keep real Kit compilation/signing and stub only the RPC boundary and
    // Mosaic's network-dependent mint/account lookup.
    vi.spyOn(RpcModule, "createRpcForSdk").mockReturnValue(rpc);
    vi.spyOn(ReadTokenTerms, "fetchTokenTerms").mockResolvedValue(
      mintTermsAt(mint, "token-2022", { decimals: 6, extensions: [] })
    );
    vi.spyOn(RpcModule, "confirmTransaction").mockResolvedValue({
      signature,
      slot: 42n,
      confirmationStatus: "confirmed",
      err: null,
    });
    vi.spyOn(MosaicSdk, "resolveTokenAccount").mockResolvedValue({
      tokenAccount,
      isInitialized: true,
      isFrozen: false,
      balance: 2_000_000n,
      uiBalance: 2,
    });
    vi.spyOn(MosaicSdk, "createBurnTransaction").mockImplementation(
      async (_rpc, _mint, owner, _amount, payer) =>
        Kit.pipe(
          Kit.createTransactionMessage({ version: 0 }),
          (tx) => Kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
          (tx) =>
            Kit.setTransactionMessageFeePayerSigner(
              typeof payer === "string" ? Kit.createNoopSigner(payer) : payer,
              tx
            ),
          (tx) =>
            Kit.appendTransactionMessageInstructions(
              [
                getBurnCheckedInstruction({
                  account: tokenAccount,
                  mint,
                  authority: owner,
                  amount: 1_250_000n,
                  decimals: 6,
                }),
              ],
              tx
            )
        )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    send.mockClear();
    sendTransaction.mockClear();
  });

  it.each(["wallet", "token account"])("burns from the authority's %s", async (source) => {
    const service = new Token2022Service(env, authority);
    await expect(
      service.burn({
        mint,
        source: source === "wallet" ? authority.address : tokenAccount,
        amount,
        authority,
      })
    ).resolves.toEqual({ signature, slot: 42n });
    expect(MosaicSdk.createBurnTransaction).toHaveBeenCalledWith(
      expect.anything(),
      mint,
      authority,
      1.25,
      authority
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects unrelated sources before building or submitting a burn", async () => {
    const service = new Token2022Service(env, authority, feePayment);
    const invalid = { mint, source: sponsor, amount };
    await expect(service.burn({ ...invalid, authority })).rejects.toThrow("Burn source must be");
    await expect(service.prepareBurn({ ...invalid, authority: authority.address })).rejects.toThrow(
      "Burn source must be"
    );
    expect(MosaicSdk.createBurnTransaction).not.toHaveBeenCalled();
    expect(feePayment.submitSponsored).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("submits the authority-signed burn through the sponsor on the burn's RPC and lifetime", async () => {
    const service = new Token2022Service(env, authority, feePayment);
    await expect(
      service.burn({ mint, source: authority.address, amount, authority })
    ).resolves.toEqual({ signature, slot: 42n });
    expect(feePayment.submitSponsored).toHaveBeenCalledExactlyOnceWith({
      transaction: expect.any(Uint8Array),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      rpc,
    });
    const [{ transaction: bytes }] = vi.mocked(feePayment.submitSponsored).mock.calls[0];
    const transaction = Kit.getTransactionDecoder().decode(bytes);
    expect(transaction.signatures[authority.address]).toBeInstanceOf(Uint8Array);
    expect(transaction.signatures[sponsor]).toBeNull();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(RpcModule.confirmTransaction).toHaveBeenCalledWith(rpc, signature);
  });

  it.each(["direct", "sponsored"])("reports confirmation errors for %s burns", async (mode) => {
    vi.mocked(RpcModule.confirmTransaction).mockResolvedValueOnce({
      signature,
      slot: 42n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, { Custom: 6000n }] },
    });
    const service = new Token2022Service(
      env,
      authority,
      mode === "sponsored" ? feePayment : undefined
    );

    await expect(
      service.burn({ mint, source: authority.address, amount, authority })
    ).rejects.toThrow(new Error('Burn failed: {"InstructionError":[0,{"Custom":"6000"}]}'));
    expect(feePayment.submitSponsored).toHaveBeenCalledTimes(mode === "sponsored" ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(mode === "direct" ? 1 : 0);
  });

  it.each([false, true])("prepares unsigned burns with simulation=%s", async (simulate) => {
    const simulation = { success: true, logs: [], unitsConsumed: 123n, error: null };
    vi.spyOn(RpcModule, "simulateTransaction").mockResolvedValue(simulation);
    const service = new Token2022Service(env, authority, feePayment);
    const prepared = await service.prepareBurn(
      { mint, source: tokenAccount, amount, authority: authority.address },
      simulate
    );
    const bytes = Kit.getBase64Encoder().encode(prepared.serializedTx);
    const transaction = Kit.getTransactionDecoder().decode(bytes);
    expect(transaction.signatures).toEqual({ [authority.address]: null });
    expect(feePayment.getFeePayer).not.toHaveBeenCalled();
    expect(prepared).toMatchObject(lifetime);
    expect(prepared.simulation).toEqual(simulate ? simulation : undefined);
    expect(RpcModule.simulateTransaction).toHaveBeenCalledTimes(simulate ? 1 : 0);
    expect(feePayment.submitSponsored).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the mint live and refuses a paused mint or a stale scale before building", async () => {
    const service = new Token2022Service(env, authority, feePayment);
    vi.mocked(ReadTokenTerms.fetchTokenTerms).mockResolvedValueOnce(
      mintTermsAt(mint, "token-2022", {
        decimals: 6,
        extensions: [{ __kind: "PausableConfig", authority: authority.address, paused: true }],
      })
    );
    await expect(
      service.burn({ mint, source: authority.address, amount, authority })
    ).rejects.toThrow(MosaicAmountError);
    vi.mocked(ReadTokenTerms.fetchTokenTerms).mockResolvedValueOnce(
      mintTermsAt(mint, "token-2022", { decimals: 9, extensions: [] })
    );
    await expect(
      service.prepareBurn({ mint, source: tokenAccount, amount, authority: authority.address })
    ).rejects.toThrow("The mint has 9 decimals on chain");
    expect(MosaicSdk.createBurnTransaction).not.toHaveBeenCalled();
    expect(feePayment.submitSponsored).not.toHaveBeenCalled();
  });
});
