import type { EarnVaultPosition, EarnWalletPosition } from "@sdp/types/earn";
import type { EarnCoreStrategy } from "@sdp/types/earn-core";
import { earnStrategyParticipation } from "@sdp/types/provider-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowPathname } from "@/test/window-location";
import {
  appendVaultPositionsRead,
  type EarnVaultPositionsRead,
  earnVaultPositionsRefreshInterval,
  earnWalletSummaryRefreshInterval,
  fetchEarnStrategies,
  fetchEarnVaultPositions,
  fetchEarnWalletPositionSummary,
  fetchEarnWalletPositions,
  readEarnVaultPositions,
} from "./earn-data";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("last verified vault values", () => {
  it("retains a value through repeated partial reads without retaining unbounded history", () => {
    const position: EarnVaultPosition = {
      id: "position",
      provider: "veda",
      providerReference: "vault",
      custodyWalletId: "wallet",
      tokenMint: USDC,
      shareMint: "share",
      label: "Veda",
      createdAt: TIMESTAMP,
      closedAt: null,
      shares: "10",
      tokenValue: "9.98",
      feeSponsored: false,
    };
    let history: readonly EarnVaultPositionsRead[] = [
      { positions: [position], startedAt: 1, landedAt: 2 },
    ];
    for (let at = 3; at < 100; at += 1) {
      history = appendVaultPositionsRead(history, {
        positions: [{ ...position, tokenValue: undefined }],
        startedAt: at,
        landedAt: at + 1,
      });
      expect(history).toHaveLength(2);
      expect(history[0]?.positions[0]?.tokenValue).toBe("9.98");
      expect(history[1]?.positions[0]?.tokenValue).toBeUndefined();
    }
    const recovered = {
      positions: [{ ...position, tokenValue: "10.01" }],
      startedAt: 101,
      landedAt: 102,
    };
    expect(appendVaultPositionsRead(history, recovered)).toEqual([recovered]);
    const closed = { positions: [], startedAt: 103, landedAt: 104 };
    expect(appendVaultPositionsRead(history, closed)).toEqual([closed]);
  });
});

function strategy(id: string): EarnCoreStrategy {
  return {
    ...earnStrategyParticipation("kamino"),
    id,
    provider: "kamino",
    providerReference: `${id}-ref`,
    name: id,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.05",
    liquidityTerm: "instant",
    status: "active",
    depositSlippage: null,
    withdrawalSlippage: null,
    hostCluster: "devnet",
    fundable: true,
    feeSponsored: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    rate: {
      value: "0.05",
      measure: "apy",
      basis: "provider_reported",
      observedAt: null,
      source: { provider: "kamino", providerReference: `${id}-ref` },
    },
    capabilities: { deposit: true, withdraw: true, admission: "evaluated_on_prepare" },
  };
}

/** Stubs the BFF with a fixed catalogue, paging it the way the API would. */
function stubCatalogue(total: number, pageSize = 100) {
  const all = Array.from({ length: total }, (_, index) => strategy(`s${index}`));
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: string) => {
    calls.push(input);
    const page = Number(new URL(input, "https://sdp.test").searchParams.get("page") ?? "1");
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { strategies: slice, total, page, pageSize } }),
    } as unknown as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/markets/treasury-solutions"));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("earnWalletSummaryRefreshInterval", () => {
  it("refreshes drawer details at the prior cadence without polling the overview as often", () => {
    expect(earnWalletSummaryRefreshInterval(false, "production")).toBe(60_000);
    expect(earnWalletSummaryRefreshInterval(true, "production")).toBe(15_000);
    expect(earnWalletSummaryRefreshInterval(false, "development")).toBe(3_000);
    expect(earnWalletSummaryRefreshInterval(true, "development")).toBe(3_000);
  });
});

describe("fetchEarnStrategies", () => {
  it("returns a single short page without asking for a second", async () => {
    const { calls } = stubCatalogue(12);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("pages past the API's 100-row cap instead of silently truncating", async () => {
    // The regression this guards: one unpaged request dropped every strategy
    // past the first 100, with no error anywhere.
    const { calls } = stubCatalogue(250);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("page=1");
    expect(calls[2]).toContain("page=3");
    expect(new Set(strategies.map((entry) => entry.id)).size).toBe(250);
  });

  it("stops on an exactly-full final page rather than fetching an empty one", async () => {
    const { calls } = stubCatalogue(200);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  it("fails closed on a short page when the reported total says rows are missing", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { strategies: [strategy("only")], total: 9_999, page: 1, pageSize: 100 },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Earn strategies pagination ended before the reported total"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the loop when every page stays full and the total never resolves", async () => {
    // Pathological provider/API response: full pages forever. The cap keeps the
    // dashboard from hanging on an unbounded fetch.
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            strategies: Array.from({ length: 100 }, (_, index) => strategy(`x${index}`)),
            total: Number.MAX_SAFE_INTEGER,
            page: 1,
            pageSize: 100,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Earn strategies pagination exceeded its safety limit"
    );
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("throws with the API's message when a page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({ error: { message: "Kamino is not configured for sandbox mode." } }),
        } as unknown as Response;
      })
    );

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Kamino is not configured for sandbox mode."
    );
  });
});

function vaultPosition(
  id: string,
  provider = "kamino"
): EarnVaultPosition & { source: { walletId: string } } {
  return {
    id,
    provider,
    providerReference: `${id}-ref`,
    label: id,
    custodyWalletId: "cwlt_1",
    source: { walletId: "cwlt_1" },
    tokenMint: USDC,
    shareMint: `${id}-share-mint`,
    createdAt: TIMESTAMP,
    closedAt: null,
    feeSponsored: false,
    shares: "1",
    tokenValue: "1.05",
  };
}

describe("fetchEarnVaultPositions", () => {
  it("requires the API to acknowledge every confirmed movement on the balance read", async () => {
    const data = { positions: [vaultPosition("vault_1")], hasMore: false, nextCursor: null };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data }))
      .mockResolvedValueOnce(
        Response.json({
          data: { ...data, balanceReadContext: { afterMovementIds: ["one"], minimumSlot: 10 } },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            ...data,
            balanceReadContext: { afterMovementIds: ["one", "two"], minimumSlot: 12 },
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchEarnVaultPositions(["one", "two"])).rejects.toThrow(/confirmation freshness/);
    await expect(fetchEarnVaultPositions(["one", "two"])).rejects.toThrow(/confirmation freshness/);
    await expect(fetchEarnVaultPositions(["one", "two"])).resolves.toEqual(data.positions);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("afterMovementIds=one%2Ctwo");
  });
  it("follows every live keyset page without filtering un-surfaced providers", async () => {
    // Pages that report more must be full, so the first page carries a whole
    // page of rows and only the final one is short.
    const pages = [
      {
        positions: Array.from({ length: 100 }, (_, index) =>
          vaultPosition(`vault_${index}`, "upshift")
        ),
        hasMore: true,
        nextCursor: "cursor_1",
      },
      {
        positions: [vaultPosition("vault_2", "kamino")],
        hasMore: false,
        nextCursor: null,
      },
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: pages.shift() }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const positions = await fetchEarnVaultPositions();

    expect(positions).toHaveLength(101);
    expect(new Set(positions.map((position) => position.provider))).toEqual(
      new Set(["upshift", "kamino"])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/dashboard/markets/earn/positions?sourceType=wallet&limit=100"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/dashboard/markets/earn/positions?sourceType=wallet&limit=100&before=cursor_1"
    );
  });

  it("fails closed when hasMore carries no advancing cursor", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: { positions: [vaultPosition("vault_1")], hasMore: true, nextCursor: null },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnVaultPositions()).rejects.toThrow(
      "Vault positions pagination did not advance"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function walletPosition(
  id: string
): EarnWalletPosition & { source: { ownerAddress: string }; feeSponsored: boolean } {
  return {
    id,
    ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    source: { ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    feeSponsored: false,
    provider: "kamino",
    providerReference: `${id}-ref`,
    label: id,
    tokenMint: USDC,
    shareMint: `${id}-share-mint`,
    createdAt: TIMESTAMP,
    closedAt: null,
    tokenValue: "1.05",
  };
}

describe("wallet position reads", () => {
  it("pages one wallet to the end", async () => {
    const pages = [
      {
        positions: Array.from({ length: 100 }, () => walletPosition("p1")),
        hasMore: true,
        nextCursor: "cursor_1",
      },
      { positions: [walletPosition("p2")], hasMore: false, nextCursor: null },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: pages.shift() }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).resolves.toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when a wallet feed keeps minting fresh cursors past the safety limit", async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      const current = page;
      page += 1;
      return new Response(
        JSON.stringify({
          data: {
            positions: Array.from({ length: 100 }, () => walletPosition(`p${current}`)),
            hasMore: true,
            nextCursor: `cursor_${current}`,
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).rejects.toThrow("Wallet positions pagination exceeded its safety limit");
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("accepts a twentieth page that ends the feed without a twenty-first request", async () => {
    // The boundary this pins: the last allowed page may still be the one that
    // closes the feed. An off-by-one in the loop bound would either reject
    // this final page or fire an unnecessary extra request.
    let page = 0;
    const fetchMock = vi.fn(async () => {
      const current = page;
      page += 1;
      return new Response(
        JSON.stringify({
          data: {
            positions: Array.from({ length: 100 }, () => walletPosition(`p${current}`)),
            hasMore: current < 19,
            nextCursor: current < 19 ? `cursor_${current}` : null,
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).resolves.toHaveLength(20 * 100);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("fails loudly when a wallet cursor repeats", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              positions: Array.from({ length: 100 }, () => walletPosition("p1")),
              hasMore: true,
              nextCursor: "same_cursor",
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).rejects.toThrow("Wallet positions pagination did not advance");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the complete aggregate summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                positions: [],
                hasMore: false,
                nextCursor: null,
                coverage: "sdp_tracked_positions",
                summary: {
                  costBasisCoverage: "complete",
                  unknownCostBasisPositionCount: 0,
                  walletCount: 2,
                  positionCount: 3,
                  unavailablePositionCount: 0,
                  totalsByStrategy: [
                    {
                      provider: "kamino",
                      providerReference: "vault_1",
                      label: "Vault one",
                      ownerAddresses: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
                      positions: [walletPosition("p1")],
                      walletCount: 1,
                      positionCount: 1,
                      totalsByToken: [
                        {
                          tokenMint: USDC,
                          walletCount: 1,
                          positionCount: 1,
                          unavailablePositionCount: 0,
                          tokenValue: "1.05",
                        },
                      ],
                    },
                  ],
                  totalsByToken: [
                    {
                      tokenMint: USDC,
                      walletCount: 2,
                      positionCount: 3,
                      unavailablePositionCount: 0,
                      tokenValue: "3.15",
                    },
                  ],
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(fetchEarnWalletPositionSummary()).resolves.toMatchObject({
      walletCount: 2,
      positionCount: 3,
      totalsByStrategy: [{ provider: "kamino", positions: [{ id: "p1" }] }],
      totalsByToken: [{ tokenMint: USDC, tokenValue: "3.15" }],
    });
  });

  it.each([
    {
      name: "a non-array totalsByStrategy",
      summary: {
        walletCount: 0,
        positionCount: 0,
        unavailablePositionCount: 0,
        totalsByStrategy: {},
        totalsByToken: [],
      },
    },
    {
      name: "a missing positionCount",
      summary: {
        walletCount: 0,
        unavailablePositionCount: 0,
        totalsByStrategy: [],
        totalsByToken: [],
      },
    },
    {
      name: "a numeric withdrawableShares inside a position record",
      summary: {
        walletCount: 1,
        positionCount: 1,
        unavailablePositionCount: 0,
        totalsByStrategy: [
          {
            provider: "kamino",
            providerReference: "vault_1",
            label: "Vault one",
            positions: [{ ...walletPosition("p1"), withdrawableShares: 0 }],
            walletCount: 1,
            positionCount: 1,
            totalsByToken: [],
          },
        ],
        totalsByToken: [],
      },
    },
  ])("refuses the summary envelope when the contract drifts: $name", async ({ summary }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                positions: [],
                hasMore: false,
                nextCursor: null,
                coverage: "sdp_tracked_positions",
                summary,
              },
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    await expect(fetchEarnWalletPositionSummary()).rejects.toThrow();
  });
});

/**
 * The program-read discrimination is the whole behavioural surface of the
 * multi-program change on the web side, and CI runs none of these files — so
 * without this block the rule has zero automated coverage anywhere.
 */
describe("earnVaultPositionsRefreshInterval", () => {
  const position: EarnVaultPosition = {
    id: "position",
    provider: "kamino",
    providerReference: "vault",
    custodyWalletId: "wallet",
    tokenMint: USDC,
    shareMint: "shares",
    label: "Vault",
    createdAt: TIMESTAMP,
    closedAt: null,
    tokenValue: "10",
    shares: "10",
    feeSponsored: false,
  };
  const read = (positions: EarnVaultPosition[]) => ({ positions, startedAt: 0, landedAt: 0 });

  it("polls live values while any position exists", () => {
    expect(earnVaultPositionsRefreshInterval(read([position]))).toBe(15_000);
  });

  it("idles once a read lists no position", () => {
    // A first position only arrives through a movement Treasury reads directly.
    expect(earnVaultPositionsRefreshInterval(read([]))).toBe(120_000);
  });

  it("keeps the live cadence until a read says otherwise", () => {
    expect(earnVaultPositionsRefreshInterval(undefined)).toBe(15_000);
  });
});

describe("batched confirmation reads", () => {
  it("keeps each position's verified snapshot and uses its greatest slot across batches", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `a-${i}`).concat("b-0");
    const positions = new Map(ids.map((id) => [id, id.startsWith("a-") ? "a" : "b"]));
    const slots = [200, 100, 300];
    const amounts = ["2", "1", "999"];
    const fetchMock = vi.fn(async (input: string) => {
      const batch =
        new URL(input, "https://example.test").searchParams.get("afterMovementIds")?.split(",") ??
        [];
      expect(batch.length).toBeLessThanOrEqual(100);
      return Response.json({
        data: {
          positions: [
            { ...vaultPosition("a"), tokenValue: amounts.shift() },
            { ...vaultPosition("b"), tokenValue: "3" },
          ],
          hasMore: false,
          nextCursor: null,
          balanceReadContext: { afterMovementIds: batch, minimumSlot: slots.shift() },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const read = await readEarnVaultPositions(ids, positions);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(read.afterMovementIds).toEqual(ids);
    expect(read.minimumSlot).toBe(300);
    expect(read.positions.map(({ id, tokenValue }) => [id, tokenValue])).toEqual([
      ["a", "2"],
      ["b", "3"],
    ]);
  });

  it("rejects the entire refresh if a later batch lacks confirmation evidence", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `movement-${i}`);
    const positions = new Map(ids.map((id) => [id, "a"]));
    const fetchMock = vi.fn(async (input: string) => {
      const batch =
        new URL(input, "https://example.test").searchParams.get("afterMovementIds")?.split(",") ??
        [];
      const page = { positions: [vaultPosition("a")], hasMore: false, nextCursor: null };
      // Only the full first batch proves its movements; the second answers without evidence.
      return Response.json({
        data:
          batch.length === 100
            ? { ...page, balanceReadContext: { afterMovementIds: batch, minimumSlot: 200 } }
            : page,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(readEarnVaultPositions(ids, positions)).rejects.toThrow(/confirmation freshness/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a closed holding from another position's unbounded read", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `closed-${i}`).concat("open-0");
    const positions = new Map(ids.map((id) => [id, id.startsWith("closed") ? "closed" : "open"]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const batch =
          new URL(input, "https://example.test").searchParams.get("afterMovementIds")?.split(",") ??
          [];
        return Response.json({
          data: {
            positions:
              batch.length === 100
                ? [vaultPosition("open")]
                : [vaultPosition("closed"), vaultPosition("open")],
            hasMore: false,
            nextCursor: null,
            balanceReadContext: { afterMovementIds: batch, minimumSlot: 200 },
          },
        });
      })
    );
    const read = await readEarnVaultPositions(ids, positions);
    expect(read.positions.map(({ id }) => id)).toEqual(["open"]);
  });
});

it("limits concurrent confirmation batches to two while draining a large backlog", async () => {
  const ids = Array.from({ length: 350 }, (_, i) => `movement-${i}`);
  const positions = new Map(ids.map((id) => [id, "a"]));
  let active = 0;
  let maximumActive = 0;
  const finish: (() => void)[] = [];
  const fetchMock = vi.fn(async (input: string) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const batch =
      new URL(input, "https://example.test").searchParams.get("afterMovementIds")?.split(",") ?? [];
    await new Promise<void>((resolve) => finish.push(resolve));
    active -= 1;
    return Response.json({
      data: {
        positions: [vaultPosition("a")],
        hasMore: false,
        nextCursor: null,
        balanceReadContext: { afterMovementIds: batch, minimumSlot: 200 },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const read = readEarnVaultPositions(ids, positions);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const resolve of finish.splice(0)) resolve();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(maximumActive).toBe(2);
  for (const resolve of finish.splice(0)) resolve();
  await expect(read).resolves.toMatchObject({ afterMovementIds: ids, minimumSlot: 200 });
  expect(active).toBe(0);
});
