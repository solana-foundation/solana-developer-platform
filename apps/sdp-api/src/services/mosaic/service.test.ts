/**
 * MosaicService.createToken — Kora fee-sponsorship routing
 *
 * Locks in the invariant that sRFC-37 (Token-ACL/ABL) deploys are sponsored by
 * Kora: the fee payer passed to the mosaic-sdk template is the Kora address
 * (distinct from the custody mint authority), and the submit path is NOT
 * bypassed to force custody self-payment. Plain (non-sRFC-37) deploys behave
 * identically. The whole createToken path is mocked out in the route-level
 * tests, so this is the only place the fee-payer resolution is asserted.
 */

import type { Address, Signature, TransactionSigner } from "@solana/kit";
import * as Kit from "@solana/kit";
import * as MosaicSdk from "@solana/mosaic-sdk";
import * as Signers from "@solana/signers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { MosaicService } from "@/services/mosaic";
import type { CreateTokenOptions } from "@/services/mosaic/types";
import type { FeePaymentPort } from "@/services/ports/fee-payment.port";
import * as RpcModule from "@/services/solana/rpc";
import { env } from "@/test/helpers/env";

// Sentinels — the SDK template builder is stubbed, so its concrete return value
// is irrelevant; we only care which arguments the service hands it.
const FAKE_FULL_TX = { __sentinel: "full-tx" } as const;
const FAKE_LIST_ADDRESS = "List1111111111111111111111111111111111111" as Address;
// Structurally-valid placeholder addresses for helper defaults, so callers that
// don't override these still get a well-formed CreateTokenOptions.
const PLACEHOLDER_MINT_AUTHORITY = "Mint1111111111111111111111111111111111111" as Address;
const PLACEHOLDER_FEE_PAYER = Kit.createNoopSigner(
  "Fee11111111111111111111111111111111111111" as Address
);

type CreateStablecoinReturn = Awaited<ReturnType<typeof MosaicSdk.createStablecoinInitTransaction>>;

/**
 * Named view over the positional createStablecoinInitTransaction arguments, so
 * assertions read by name rather than by brittle index. If the SDK signature
 * shifts, the named field reads the wrong slot and the assertion fails loudly.
 * Signature: (rpc, name, symbol, decimals, uri, mintAuthority, mint, feePayer,
 *   aclMode, metadataAuth, pausableAuth, confidentialAuth, delegateAuth,
 *   enableSrfc37, freezeAuthority)
 */
function stablecoinBuilderCall(call: readonly unknown[]) {
  const [, , , , , mintAuthority, , feePayer, , , , , , enableSrfc37, freezeAuthority] = call;
  return { mintAuthority, feePayer, enableSrfc37, freezeAuthority };
}

/**
 * The private submit method exposed for spying. Tests that only assert routing
 * stub this so they never touch the real signing/submission machinery.
 */
type SubmitProto = {
  signAndSubmitWithMintKeypair: (
    fullTx: unknown,
    mintKeypair: TransactionSigner
  ) => Promise<{ signature: string; slot: bigint }>;
};

/**
 * The private packet-size guard exposed for spying. createToken now calls this
 * before submitting (to split a long-uri create into a follow-up tx), but the
 * SDK template builder is stubbed to a sentinel here, so the real partial-sign
 * inside it has nothing to measure. Default it to "fits" so routing/derivation
 * tests stay on the single-tx path; the overflow split is covered separately.
 */
type PacketSizeProto = {
  exceedsPacketSize: (fullTx: unknown) => Promise<boolean>;
};

function makeFeePayment(koraAddress: Address): {
  port: FeePaymentPort;
  getFeePayer: ReturnType<typeof vi.fn>;
  signAndSend: ReturnType<typeof vi.fn>;
} {
  const getFeePayer = vi.fn().mockResolvedValue(koraAddress);
  const signAndSend = vi.fn();
  const port: FeePaymentPort = {
    providerId: "test-kora",
    getFeePayer,
    signAsFeePayer: vi.fn(),
    signAndSend,
  };
  return { port, getFeePayer, signAndSend };
}

function stablecoinOptions(overrides: Partial<CreateTokenOptions> = {}): CreateTokenOptions {
  return {
    template: "stablecoin",
    metadata: { name: "Test USD", symbol: "TUSD", uri: "https://example.com/t.json" },
    decimals: 6,
    mintAuthority: PLACEHOLDER_MINT_AUTHORITY,
    // null by default so the helper doesn't accidentally enable sRFC-37
    // (enableSrfc37 = requested && freezeAuthority !== null); tests that need it
    // pass a non-null freezeAuthority explicitly.
    freezeAuthority: null,
    feePayer: PLACEHOLDER_FEE_PAYER,
    enableTokenAcl: true,
    ...overrides,
  };
}

describe("MosaicService.createToken — Kora sponsorship", () => {
  let signer: TransactionSigner;
  let koraAddress: Address;
  let service: MosaicService;
  let fee: ReturnType<typeof makeFeePayment>;
  let builderSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    signer = await Kit.generateKeyPairSigner();
    koraAddress = (await Kit.generateKeyPairSigner()).address;
    fee = makeFeePayment(koraAddress);
    service = new MosaicService(
      env as ConstructorParameters<typeof MosaicService>[0],
      signer,
      fee.port
    );

    // Stub the template builder: capture args, return a sentinel transaction.
    builderSpy = vi
      .spyOn(MosaicSdk, "createStablecoinInitTransaction")
      .mockResolvedValue(FAKE_FULL_TX as unknown as CreateStablecoinReturn);

    // List PDA derivation is exercised separately; default to a sentinel.
    vi.spyOn(MosaicSdk, "getListConfigPda").mockResolvedValue(FAKE_LIST_ADDRESS);

    // createToken probes the packet size before submitting; the stubbed builder
    // returns a sentinel the real partial-sign can't measure, so default to
    // "fits" and keep these tests on the single-tx path.
    vi.spyOn(
      MosaicService.prototype as unknown as PacketSizeProto,
      "exceedsPacketSize"
    ).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** custody signs the mint authority; sRFC-37 enabled with a real freeze authority. */
  function srfc37Options(): CreateTokenOptions {
    return stablecoinOptions({
      mintAuthority: signer.address,
      // any non-null freeze authority enables sRFC-37 (value is opaque to the stub)
      freezeAuthority: signer.address,
      feePayer: signer,
      enableTokenAcl: true,
    });
  }

  describe("fee-payer resolution", () => {
    it("passes the Kora address (not custody) as fee payer for an sRFC-37 deploy", async () => {
      const submitSpy = vi
        .spyOn(MosaicService.prototype as unknown as SubmitProto, "signAndSubmitWithMintKeypair")
        .mockResolvedValue({ signature: "sig", slot: 1n });

      await service.createToken(srfc37Options());

      expect(fee.getFeePayer).toHaveBeenCalledTimes(1);
      const { feePayer } = stablecoinBuilderCall(builderSpy.mock.calls[0]);
      expect(feePayer).toBe(koraAddress);
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });

    it("still routes through Kora for a non-sRFC-37 deploy", async () => {
      vi.spyOn(
        MosaicService.prototype as unknown as SubmitProto,
        "signAndSubmitWithMintKeypair"
      ).mockResolvedValue({ signature: "sig", slot: 1n });

      await service.createToken(
        stablecoinOptions({
          mintAuthority: signer.address,
          freezeAuthority: signer.address,
          feePayer: signer,
          enableTokenAcl: false,
          enableAbl: false,
        })
      );

      expect(fee.getFeePayer).toHaveBeenCalledTimes(1);
      expect(stablecoinBuilderCall(builderSpy.mock.calls[0]).feePayer).toBe(koraAddress);
    });

    it("falls back to options.feePayer when no fee sponsor is configured", async () => {
      const ownFeePayer = await Kit.generateKeyPairSigner();
      const unsponsored = new MosaicService(
        env as ConstructorParameters<typeof MosaicService>[0],
        signer
      );
      vi.spyOn(
        MosaicService.prototype as unknown as SubmitProto,
        "signAndSubmitWithMintKeypair"
      ).mockResolvedValue({ signature: "sig", slot: 1n });

      await unsponsored.createToken(
        stablecoinOptions({
          mintAuthority: signer.address,
          freezeAuthority: signer.address,
          feePayer: ownFeePayer,
          enableTokenAcl: true,
        })
      );

      expect(fee.getFeePayer).not.toHaveBeenCalled();
      expect(stablecoinBuilderCall(builderSpy.mock.calls[0]).feePayer).toBe(ownFeePayer);
    });

    it("prepareCreateToken respects options.feePayer even when Kora is configured", async () => {
      // A prepared transaction is submitted by the client, who cannot sign as
      // Kora — so the fee payer must stay options.feePayer, not the sponsor.
      vi.spyOn(Kit, "compileTransaction").mockReturnValue({ __sentinel: "compiled" } as never);
      vi.spyOn(Kit, "getBase64EncodedWireTransaction").mockReturnValue("base64-tx" as never);

      const result = await service.prepareCreateToken(srfc37Options());

      expect(fee.getFeePayer).not.toHaveBeenCalled();
      expect(stablecoinBuilderCall(builderSpy.mock.calls[0]).feePayer).toBe(signer);
      expect(result.serializedTx).toBe("base64-tx");
    });
  });

  describe("submit path", () => {
    it("submits sRFC-37 deploys with no fee-payment-bypass directive", async () => {
      const submitSpy = vi
        .spyOn(MosaicService.prototype as unknown as SubmitProto, "signAndSubmitWithMintKeypair")
        .mockResolvedValue({ signature: "sig", slot: 1n });

      await service.createToken(srfc37Options());

      // The submit method is invoked with only the transaction and mint keypair.
      // If a future change reintroduces a custody-pays bypass (e.g. a third
      // options arg), this guard fails. The Kora path itself is asserted by the
      // "two-signer path" test below.
      expect(submitSpy).toHaveBeenCalledTimes(1);
      expect(submitSpy.mock.calls[0]).toHaveLength(2);
    });

    it("submits via the Kora two-signer path (signAndSend), not direct RPC", async () => {
      const koraSignature = "kora-sig" as Signature;
      fee.signAndSend.mockResolvedValue(koraSignature);

      // Stub the signing/encoding primitives so no real transaction is needed.
      const partialSpy = vi
        .spyOn(Signers, "partiallySignTransactionMessageWithSigners")
        .mockResolvedValue({ __sentinel: "partial-tx" } as never);
      vi.spyOn(Kit, "getTransactionEncoder").mockReturnValue({
        encode: () => new Uint8Array([1, 2, 3]),
      } as never);
      const confirmSpy = vi.spyOn(RpcModule, "confirmTransaction").mockResolvedValue({
        signature: koraSignature,
        slot: 7n,
        confirmationStatus: "confirmed",
        err: null,
      } as Awaited<ReturnType<typeof RpcModule.confirmTransaction>>);

      const result = await service.createToken(srfc37Options());

      expect(partialSpy).toHaveBeenCalledWith(FAKE_FULL_TX);
      expect(fee.signAndSend).toHaveBeenCalledTimes(1);
      expect(fee.signAndSend).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(result.signature).toBe(koraSignature);
      expect(result.slot).toBe(7n);
    });

    it("throws TRANSACTION_FAILED carrying the on-chain error when confirmation reports failure", async () => {
      const koraSignature = "kora-sig" as Signature;
      fee.signAndSend.mockResolvedValue(koraSignature);

      vi.spyOn(Signers, "partiallySignTransactionMessageWithSigners").mockResolvedValue({
        __sentinel: "partial-tx",
      } as never);
      vi.spyOn(Kit, "getTransactionEncoder").mockReturnValue({
        encode: () => new Uint8Array([1, 2, 3]),
      } as never);
      const onChainError = { InstructionError: [0, { Custom: 6001 }] };
      vi.spyOn(RpcModule, "confirmTransaction").mockResolvedValue({
        signature: koraSignature,
        slot: 7n,
        confirmationStatus: "confirmed",
        err: onChainError,
      } as Awaited<ReturnType<typeof RpcModule.confirmTransaction>>);

      const error = await service.createToken(srfc37Options()).then(
        () => {
          throw new Error("expected createToken to reject");
        },
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("TRANSACTION_FAILED");
      expect(appError.statusCode).toBe(400);
      expect(appError.message).toBe(`Transaction failed: ${JSON.stringify(onChainError)}`);
    });

    it("throws TRANSACTION_FAILED carrying the on-chain error on the direct-submit path", async () => {
      const directSignature = "direct-sig" as Signature;
      const sendTransaction = vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(directSignature),
      });
      vi.spyOn(RpcModule, "createRpcForSdk").mockReturnValue({
        sendTransaction,
      } as unknown as ReturnType<typeof RpcModule.createRpcForSdk>);
      const unsponsored = new MosaicService(
        env as ConstructorParameters<typeof MosaicService>[0],
        signer
      );

      vi.spyOn(Kit, "signTransactionMessageWithSigners").mockResolvedValue({
        __sentinel: "signed-tx",
      } as never);
      vi.spyOn(Kit, "getBase64EncodedWireTransaction").mockReturnValue("base64-tx" as never);
      const onChainError = { InstructionError: [1, { Custom: 42 }] };
      vi.spyOn(RpcModule, "confirmTransaction").mockResolvedValue({
        signature: directSignature,
        slot: 9n,
        confirmationStatus: "confirmed",
        err: onChainError,
      } as Awaited<ReturnType<typeof RpcModule.confirmTransaction>>);

      const error = await unsponsored.createToken(srfc37Options()).then(
        () => {
          throw new Error("expected createToken to reject");
        },
        (e: unknown) => e
      );

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("TRANSACTION_FAILED");
      expect(appError.statusCode).toBe(400);
      expect(appError.message).toBe(`Transaction failed: ${JSON.stringify(onChainError)}`);
    });
  });

  describe("list address derivation", () => {
    it("derives the ABL list PDA from the mint authority, not the service signer", async () => {
      vi.spyOn(
        MosaicService.prototype as unknown as SubmitProto,
        "signAndSubmitWithMintKeypair"
      ).mockResolvedValue({ signature: "sig", slot: 1n });
      const listSpy = vi.spyOn(MosaicSdk, "getListConfigPda").mockResolvedValue(FAKE_LIST_ADDRESS);

      // Mint authority distinct from the service signer: the patched mosaic-sdk
      // seeds the list-config PDA from the mint authority, so the derivation must
      // follow it — deriving from `this.signer` would produce the wrong address.
      const mintAuthority = (await Kit.generateKeyPairSigner()).address;
      expect(mintAuthority).not.toBe(signer.address);

      const result = await service.createToken(
        stablecoinOptions({
          mintAuthority,
          freezeAuthority: signer.address,
          feePayer: signer,
          enableTokenAcl: true,
        })
      );

      expect(result.listAddress).toBe(FAKE_LIST_ADDRESS);
      expect(listSpy).toHaveBeenCalledWith({ authority: mintAuthority, mint: result.mint });
    });

    it("does not derive a list address for non-sRFC-37 deploys", async () => {
      vi.spyOn(
        MosaicService.prototype as unknown as SubmitProto,
        "signAndSubmitWithMintKeypair"
      ).mockResolvedValue({ signature: "sig", slot: 1n });
      const listSpy = vi.spyOn(MosaicSdk, "getListConfigPda").mockResolvedValue(FAKE_LIST_ADDRESS);

      const result = await service.createToken(
        stablecoinOptions({
          mintAuthority: signer.address,
          freezeAuthority: signer.address,
          feePayer: signer,
          enableTokenAcl: false,
          enableAbl: false,
        })
      );

      expect(result.listAddress).toBeUndefined();
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("disables sRFC-37 when freezeAuthority is null even if requested", async () => {
      const submitSpy = vi
        .spyOn(MosaicService.prototype as unknown as SubmitProto, "signAndSubmitWithMintKeypair")
        .mockResolvedValue({ signature: "sig", slot: 1n });
      const listSpy = vi.spyOn(MosaicSdk, "getListConfigPda").mockResolvedValue(FAKE_LIST_ADDRESS);

      const result = await service.createToken(
        stablecoinOptions({
          mintAuthority: signer.address,
          freezeAuthority: null,
          feePayer: signer,
          enableTokenAcl: true,
        })
      );

      // enableSrfc37 = false → no list, and the builder receives enableSrfc37=false.
      expect(result.listAddress).toBeUndefined();
      expect(listSpy).not.toHaveBeenCalled();
      expect(stablecoinBuilderCall(builderSpy.mock.calls[0]).enableSrfc37).toBe(false);
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
  });
});
