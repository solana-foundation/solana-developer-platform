import { runInClusterScope } from "@sdp/rpc/scope";
import * as RpcModule from "@sdp/rpc/solana";
import { type FeePaymentPort, Token2022Service } from "@sdp/solana/token-2022";
import {
  type Address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
} from "@solana/kit";
import * as MosaicSdk from "@solana/mosaic-sdk";
import { getBurnCheckedInstruction } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMosaicSdkRpc } from "@/services/issuance/mosaic";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";

function sandboxMosaicRpc() {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, createMosaicSdkRpc);
}

const lifetime = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 100n,
};
const SENT_SIGNATURE = signature("1".repeat(64));

// Namespace spies rely on mosaic-sdk being in server.deps.inline in vitest.config.ts.
describe("Token2022Service burn", () => {
  const clusterRpc = installClusterRpcStub();
  let authority: KeyPairSigner;
  let mint: Address;
  let tokenAccount: Address;
  let sponsor: Address;
  let feePayment: FeePaymentPort;

  function sentTransactions() {
    return clusterRpc.calls.filter((call) => call.method === "sendTransaction");
  }

  beforeEach(async () => {
    authority = await generateKeyPairSigner();
    mint = (await generateKeyPairSigner()).address;
    tokenAccount = (await generateKeyPairSigner()).address;
    sponsor = (await generateKeyPairSigner()).address;
    feePayment = {
      providerId: "test-sponsor",
      getFeePayer: vi.fn().mockResolvedValue(sponsor),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockResolvedValue(SENT_SIGNATURE),
    };
    clusterRpc.answer("sendTransaction", SENT_SIGNATURE);
    vi.spyOn(RpcModule, "confirmTransaction").mockResolvedValue({
      signature: SENT_SIGNATURE,
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
        pipe(
          createTransactionMessage({ version: 0 }),
          (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
          (tx) =>
            setTransactionMessageFeePayerSigner(
              typeof payer === "string" ? createNoopSigner(payer) : payer,
              tx
            ),
          (tx) =>
            appendTransactionMessageInstructions(
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
  });

  it.each(["wallet", "token account"])("burns from the authority's %s", async (source) => {
    const service = new Token2022Service(sandboxMosaicRpc(), authority);
    await expect(
      service.burn({
        mint,
        source: source === "wallet" ? authority.address : tokenAccount,
        amount: 1.25,
        authority,
      })
    ).resolves.toEqual({ signature: SENT_SIGNATURE, slot: 42n });
    expect(MosaicSdk.createBurnTransaction).toHaveBeenCalledWith(
      expect.anything(),
      mint,
      authority,
      1.25,
      authority
    );
    expect(sentTransactions()).toEqual([{ cluster: "devnet", method: "sendTransaction" }]);
  });

  it("rejects unrelated sources before building or submitting a burn", async () => {
    const service = new Token2022Service(sandboxMosaicRpc(), authority, feePayment);
    const invalid = { mint, source: sponsor, amount: 1.25 };
    await expect(service.burn({ ...invalid, authority })).rejects.toThrow("Burn source must be");
    await expect(service.prepareBurn({ ...invalid, authority: authority.address })).rejects.toThrow(
      "Burn source must be"
    );
    expect(MosaicSdk.createBurnTransaction).not.toHaveBeenCalled();
    expect(feePayment.signAndSend).not.toHaveBeenCalled();
    expect(sentTransactions()).toEqual([]);
  });

  it("keeps the authority signature when handing a sponsored burn to the relay", async () => {
    const service = new Token2022Service(sandboxMosaicRpc(), authority, feePayment);
    await expect(
      service.burn({ mint, source: authority.address, amount: 1.25, authority })
    ).resolves.toEqual({ signature: SENT_SIGNATURE, slot: 42n });
    const [bytes] = vi.mocked(feePayment.signAndSend).mock.calls[0];
    const transaction = getTransactionDecoder().decode(bytes);
    expect(transaction.signatures[authority.address]).toBeInstanceOf(Uint8Array);
    expect(transaction.signatures[sponsor]).toBeNull();
    expect(sentTransactions()).toEqual([]);
    expect(RpcModule.confirmTransaction).toHaveBeenCalledWith(expect.anything(), SENT_SIGNATURE);
  });

  it.each(["direct", "sponsored"])("reports confirmation errors for %s burns", async (mode) => {
    vi.mocked(RpcModule.confirmTransaction).mockResolvedValueOnce({
      signature: SENT_SIGNATURE,
      slot: 42n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, { Custom: 6000n }] },
    });
    const service = new Token2022Service(
      sandboxMosaicRpc(),
      authority,
      mode === "sponsored" ? feePayment : undefined
    );

    await expect(
      service.burn({ mint, source: authority.address, amount: 1.25, authority })
    ).rejects.toThrow(new Error('Burn failed: {"InstructionError":[0,{"Custom":"6000"}]}'));
    expect(feePayment.signAndSend).toHaveBeenCalledTimes(mode === "sponsored" ? 1 : 0);
    expect(sentTransactions()).toHaveLength(mode === "direct" ? 1 : 0);
  });

  it.each([false, true])("prepares unsigned burns with simulation=%s", async (simulate) => {
    const simulation = { success: true, logs: [], unitsConsumed: 123n, error: null };
    vi.spyOn(RpcModule, "simulateTransaction").mockResolvedValue(simulation);
    const service = new Token2022Service(sandboxMosaicRpc(), authority, feePayment);
    const prepared = await service.prepareBurn(
      { mint, source: tokenAccount, amount: 1.25, authority: authority.address },
      simulate
    );
    const bytes = getBase64Encoder().encode(prepared.serializedTx);
    const transaction = getTransactionDecoder().decode(bytes);
    expect(transaction.signatures).toEqual({ [authority.address]: null });
    expect(feePayment.getFeePayer).not.toHaveBeenCalled();
    expect(prepared).toMatchObject(lifetime);
    expect(prepared.simulation).toEqual(simulate ? simulation : undefined);
    expect(RpcModule.simulateTransaction).toHaveBeenCalledTimes(simulate ? 1 : 0);
    expect(feePayment.signAndSend).not.toHaveBeenCalled();
    expect(sentTransactions()).toEqual([]);
  });
});
