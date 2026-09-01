import { PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } from "@sdp/spc-escrow";
import { privateChannelTokens } from "@sdp/types";
import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { readPrivateChannelTokenEligibility, resolveChannelToken } from "./mint";
import type { PrivateChannelProjectRpcClient } from "./project-rpc";

const INSTANCE = {
  escrowProgramId: PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
  escrowInstanceAddr: address("11111111111111111111111111111111"),
};

function projectRpc(
  getAccountInfo: () => { send: () => Promise<{ value: { owner: string } | null }> }
): PrivateChannelProjectRpcClient {
  return {
    cluster: "devnet",
    rpc: { getAccountInfo } as never,
    target: {} as never,
    probe: vi.fn(),
  };
}

describe("Private Channels token eligibility", () => {
  it("enables a registered token when its allowedMint account belongs to the escrow program", async () => {
    const rpc = projectRpc(() => ({
      send: async () => ({ value: { owner: PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } }),
    }));

    const [token] = await readPrivateChannelTokenEligibility(INSTANCE, rpc);

    expect(token).toMatchObject({
      mint: privateChannelTokens("devnet")[0]?.mint,
      enabled: true,
      exclusionReasons: [],
    });
    await expect(resolveChannelToken(INSTANCE, rpc, token?.mint)).resolves.toMatchObject({
      mint: token?.mint,
    });
  });

  it("marks a missing allowedMint account as disabled and rejects it for writes", async () => {
    const rpc = projectRpc(() => ({ send: async () => ({ value: null }) }));
    const [token] = await readPrivateChannelTokenEligibility(INSTANCE, rpc);

    expect(token).toMatchObject({
      enabled: false,
      exclusionReasons: [{ code: "NOT_ALLOWED_BY_INSTANCE" }],
    });
    await expect(resolveChannelToken(INSTANCE, rpc, token?.mint)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("reports an unavailable allowlist and fails writes closed", async () => {
    const rpc = projectRpc(() => ({
      send: async () => {
        throw new Error("RPC unavailable");
      },
    }));
    const [token] = await readPrivateChannelTokenEligibility(INSTANCE, rpc);

    expect(token).toMatchObject({
      enabled: false,
      exclusionReasons: [{ code: "ALLOWLIST_UNAVAILABLE" }],
    });
    await expect(resolveChannelToken(INSTANCE, rpc, token?.mint)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
