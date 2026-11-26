import { runInClusterScope } from "@sdp/rpc/scope";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { strategyShareDecimals } from "./strategy-mint";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
installClusterRpcStub();
vi.mock("@solana-program/token-2022", async (original) => ({
  ...(await original<typeof import("@solana-program/token-2022")>()),
  fetchMaybeMint: mocks.read,
}));
const scoped = <T>(work: () => T): T =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, work);

describe("strategy share mint facts", () => {
  it("shares concurrent reads and caches initialized token mint precision", async () => {
    const mint = "So11111111111111111111111111111111111111112";
    mocks.read.mockResolvedValue({
      exists: true,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      data: { isInitialized: true, decimals: 9 },
    });
    expect(
      await scoped(() => Promise.all([strategyShareDecimals(mint), strategyShareDecimals(mint)]))
    ).toEqual([9, 9]);
    expect(await scoped(() => strategyShareDecimals(mint))).toBe(9);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not cache a wrong program owner or uninitialized mint", async () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    mocks.read.mockResolvedValueOnce({
      exists: true,
      programAddress: "11111111111111111111111111111111",
      data: { isInitialized: true, decimals: 6 },
    });
    await expect(scoped(() => strategyShareDecimals(mint))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    mocks.read.mockResolvedValueOnce({
      exists: true,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      data: { isInitialized: false, decimals: 6 },
    });
    await expect(scoped(() => strategyShareDecimals(mint))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    mocks.read.mockResolvedValueOnce({
      exists: true,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      data: { isInitialized: true, decimals: 6 },
    });
    expect(await scoped(() => strategyShareDecimals(mint))).toBe(6);
  });
});
