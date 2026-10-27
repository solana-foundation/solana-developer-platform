import { createRpcFromTransport } from "@sdp/rpc/solana";
import { findAllowedMintPda, PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } from "@sdp/spc-escrow";
import type { PrivateChannelToken } from "@sdp/types/private-channels";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { address, type RpcTransport } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonRpcResult } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  CLOCK_RPC_ACCOUNT,
  encodedRpcAccount,
  mintRpcAccount,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

/** One registered Token-2022 token, so the capability row has extensions to judge. */
const TOKEN: PrivateChannelToken = {
  symbol: "PCT",
  mint: syntheticAddress(4_001),
  decimals: 6,
  tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
};

vi.mock("@sdp/types/private-channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/private-channels")>()),
  privateChannelTokens: () => [TOKEN],
}));

const { channelAmountBaseUnits, resolveChannelToken } = await import("./mint");

const INSTANCE = {
  escrowProgramId: PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
  escrowInstanceAddr: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
};

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  params: z.tuple([z.array(z.string())]).rest(z.unknown()),
});

let reads: string[][];

/** The instance's allowlist entry for the token: the one account other than the mint and Clock a read may name. */
const [ALLOWLIST_ENTRY] = await findAllowedMintPda(
  { instance: address(INSTANCE.escrowInstanceAddr), mint: address(TOKEN.mint) },
  { programAddress: address(INSTANCE.escrowProgramId) }
);

/** A project RPC whose allowlist entry enables the token (or not) and whose mint carries `extensions`. */
function projectRpc(options: { enabled: boolean; extensions: ExtensionArgs[] }) {
  const transport: RpcTransport = async <TResponse>({ payload }: Parameters<RpcTransport>[0]) => {
    const request = requestSchema.parse(payload);
    const [addresses] = request.params;
    reads.push(addresses);
    const value = addresses.map((at): JsonRpcResult => {
      if (at === SYSVAR_CLOCK_ADDRESS) return CLOCK_RPC_ACCOUNT;
      if (at === TOKEN.mint) {
        return mintRpcAccount("token-2022", { decimals: 6, extensions: options.extensions });
      }
      if (at !== ALLOWLIST_ENTRY) {
        throw new Error(`Private Channels read an unexpected account: ${at}`);
      }
      return options.enabled
        ? encodedRpcAccount(PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS, new Uint8Array())
        : null;
    });
    // SAFETY: the transport returns the JSON-RPC response body kit asked for.
    return { jsonrpc: "2.0", id: request.id, result: { context: { slot: 0 }, value } } as TResponse;
  };
  return { cluster: "devnet" as const, rpc: createRpcFromTransport(transport), probe: vi.fn() };
}

beforeEach(() => {
  reads = [];
});

describe("resolveChannelToken", () => {
  it("reads the allowlist entry, the mint and the Clock in one request, and returns live terms", async () => {
    const { token, terms } = await resolveChannelToken(
      INSTANCE,
      projectRpc({ enabled: true, extensions: [] }),
      TOKEN.mint
    );

    expect(token).toEqual(TOKEN);
    expect(terms.asset).toEqual({
      kind: "token",
      mint: address(TOKEN.mint),
      program: "token-2022",
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual([ALLOWLIST_ENTRY, TOKEN.mint, SYSVAR_CLOCK_ADDRESS]);
    expect(channelAmountBaseUnits("1.25", terms)).toBe(1_250_000n);
  });

  it.each([
    ["a transfer fee config", [transferFeeExtension(0, 0n)], "transfer_fee"],
    [
      "a transfer hook",
      [{ __kind: "TransferHook", authority: address(TOKEN.mint), programId: address(TOKEN.mint) }],
      "transfer_hook",
    ],
  ] as const)(
    "refuses a mint with %s, which SPC cannot carry",
    async (_label, extensions, reason) => {
      await expect(
        resolveChannelToken(
          INSTANCE,
          projectRpc({ enabled: true, extensions: [...extensions] }),
          TOKEN.mint
        )
      ).rejects.toMatchObject({ statusCode: 400, details: { reason } });
    }
  );

  it("refuses a token the instance does not enable", async () => {
    await expect(
      resolveChannelToken(INSTANCE, projectRpc({ enabled: false, extensions: [] }), TOKEN.mint)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "PCT is not enabled by this Private Channels instance.",
    });
  });
});

describe("channelAmountBaseUnits", () => {
  it("refuses more decimals than the mint has, and zero", async () => {
    const { terms } = await resolveChannelToken(
      INSTANCE,
      projectRpc({ enabled: true, extensions: [] }),
      TOKEN.mint
    );
    expect(() => channelAmountBaseUnits("1.0000001", terms)).toThrow(/too many decimal places/);
    expect(() => channelAmountBaseUnits("0", terms)).toThrow(/greater than zero/);
  });
});
