import type {
  EarnExternalWalletPosition,
  EarnProgramWithdrawalRecord,
  EarnProgramWithdrawalRecordStatus,
  EarnStrategy,
  EarnVaultDepositRequest,
  EarnVaultPosition,
} from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEarnVaultDeposit,
  earnProgramsRefreshInterval,
  earnVaultMovementRefreshInterval,
  fetchEarnExternalWalletPositionSummary,
  fetchEarnExternalWalletPositions,
  fetchEarnProgramDeposits,
  fetchEarnProgramsState,
  fetchEarnProgramWithdrawals,
  fetchEarnStrategies,
  fetchEarnVaultPositions,
  hasPrograms,
  isEarnVaultDepositAvailable,
} from "./earn-program-data";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(id: string): EarnStrategy {
  return {
    id,
    provider: "ground",
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
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("earnVaultMovementRefreshInterval", () => {
  it("polls quickly after submission and backs off without stopping early", () => {
    const startedAt = 1_000;

    expect(
      earnVaultMovementRefreshInterval({ settled: false, startedAt, now: startedAt + 14_999 })
    ).toBe(1_000);
    expect(
      earnVaultMovementRefreshInterval({ settled: false, startedAt, now: startedAt + 15_000 })
    ).toBe(2_500);
    expect(
      earnVaultMovementRefreshInterval({ settled: false, startedAt, now: startedAt + 60_000 })
    ).toBe(5_000);
  });

  it("stops polling only after the movement reaches a terminal state", () => {
    expect(earnVaultMovementRefreshInterval({ settled: true, startedAt: 0, now: 120_000 })).toBe(0);
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
          json: async () => ({ error: { message: "Ground is not configured for sandbox mode." } }),
        } as unknown as Response;
      })
    );

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Ground is not configured for sandbox mode."
    );
  });
});

function vaultPosition(id: string, provider = "kamino"): EarnVaultPosition {
  return {
    id,
    provider,
    providerReference: `${id}-ref`,
    label: id,
    custodyWalletId: "cwlt_1",
    tokenMint: USDC,
    shareMint: `${id}-share-mint`,
    createdAt: TIMESTAMP,
    closedAt: null,
    shares: "1",
    tokenValue: "1.05",
  };
}

describe("fetchEarnVaultPositions", () => {
  it("follows every live keyset page without filtering un-surfaced providers", async () => {
    const pages = [
      {
        positions: [vaultPosition("vault_1", "ground")],
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

    expect(positions.map((position) => position.provider)).toEqual(["ground", "kamino"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/dashboard/markets/earn/vault-positions?limit=100"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/dashboard/markets/earn/vault-positions?limit=100&before=cursor_1"
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

function externalWalletPosition(id: string): EarnExternalWalletPosition {
  return {
    id,
    ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
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

describe("external-wallet position reads", () => {
  it("pages one wallet to the end", async () => {
    const pages = [
      { positions: [externalWalletPosition("p1")], hasMore: true, nextCursor: "cursor_1" },
      { positions: [externalWalletPosition("p2")], hasMore: false, nextCursor: null },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: pages.shift() }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnExternalWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues one wallet past one hundred strict cursor pages", async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      const current = page;
      page += 1;
      return new Response(
        JSON.stringify({
          data: {
            positions: [externalWalletPosition(`p${current}`)],
            hasMore: current < 100,
            nextCursor: current < 100 ? `cursor_${current}` : null,
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnExternalWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).resolves.toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(101);
  });

  it("fails loudly when a wallet cursor repeats", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              positions: [externalWalletPosition("p1")],
              hasMore: true,
              nextCursor: "same_cursor",
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEarnExternalWalletPositions("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    ).rejects.toThrow("External-wallet positions pagination did not advance");
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
                summary: {
                  walletCount: 2,
                  positionCount: 3,
                  unavailablePositionCount: 0,
                  totalsByStrategy: [],
                  totalsByToken: [],
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(fetchEarnExternalWalletPositionSummary()).resolves.toMatchObject({
      walletCount: 2,
      positionCount: 3,
    });
  });
});

describe("vault deposit availability", () => {
  const kamino = { ...strategy("kamino-vault"), provider: "kamino" };
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  };

  it("opens only an active, fundable, surfaced vault-direct strategy in an enabled environment", () => {
    expect(isEarnVaultDepositAvailable(kamino, "sandbox", providerAccess)).toBe(true);
    expect(isEarnVaultDepositAvailable(kamino, "production", providerAccess)).toBe(false);
    expect(
      isEarnVaultDepositAvailable({ ...kamino, fundable: false }, "sandbox", providerAccess)
    ).toBe(false);
    expect(
      isEarnVaultDepositAvailable({ ...kamino, status: "paused" }, "sandbox", providerAccess)
    ).toBe(false);
    expect(
      isEarnVaultDepositAvailable({ ...kamino, provider: "ground" }, "sandbox", providerAccess)
    ).toBe(false);
  });
});

describe("createEarnVaultDeposit", () => {
  it("sends idempotency only as a header and allowlists the JSON body", async () => {
    const deposit = {
      positionId: "position_1",
      movementId: "movement_1",
      status: "submitted",
      signature: "signature_1",
      failureReason: null,
      replayed: false,
      strategy: {
        id: "strategy_1",
        name: "Vault one",
        provider: "kamino",
        providerReference: "vault_1",
        hostCluster: "devnet",
      },
    } as const;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: deposit }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const untypedInput = {
      strategyId: "strategy_1",
      custodyWalletId: "cwlt_1",
      amount: "10",
      minSharesOut: "9.9",
      requestId: "must-not-be-forwarded",
    } as EarnVaultDepositRequest & { requestId: string };

    const result = await createEarnVaultDeposit(untypedInput, "deposit-key");

    expect(result).toEqual({
      ok: true,
      status: 201,
      data: { kind: "submitted", deposit },
    });
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(JSON.parse(String(options?.body))).toEqual({
      strategyId: "strategy_1",
      custodyWalletId: "cwlt_1",
      amount: "10",
      minSharesOut: "9.9",
    });
    expect(String(options?.body)).not.toContain("requestId");
  });

  it("rejects a success envelope whose deposit record is incomplete", async () => {
    // The `as unknown as EarnVaultDeposit` this replaced asserted the record
    // rather than checking it, so a movement with no signature type-checked as
    // a settled deposit and failed further downstream.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { positionId: "position_1" } }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    const result = await createEarnVaultDeposit(
      { strategyId: "strategy_1", custodyWalletId: "cwlt_1", amount: "10" },
      "deposit-key"
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "Invalid vault deposit response", status: 201 });
  });

  it("refuses an approval hold that did not arrive as a 202", async () => {
    // Created AND held is a contradiction; it must not resolve in the
    // customer's favour.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "SIGNING_PENDING", message: "Requires policy approval" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const result = await createEarnVaultDeposit(
      { strategyId: "strategy_1", custodyWalletId: "cwlt_1", amount: "10" },
      "deposit-key"
    );

    expect(result.ok).toBe(false);
  });

  it("normalizes a policy-held 202 into an approval-pending outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "SIGNING_PENDING",
                message: "Wallet operation requires policy approval",
                details: {
                  approvalRequestId: "approval_1",
                  walletOperationId: "operation_1",
                },
              },
            }),
            { status: 202, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const result = await createEarnVaultDeposit(
      { strategyId: "strategy_1", custodyWalletId: "cwlt_1", amount: "10" },
      "deposit-key"
    );

    expect(result).toEqual({
      ok: true,
      status: 202,
      data: {
        kind: "approval_pending",
        message: "Wallet operation requires policy approval",
        approvalRequestId: "approval_1",
        walletOperationId: "operation_1",
      },
    });
  });
});

/**
 * The program-read discrimination is the whole behavioural surface of the
 * multi-program change on the web side, and CI runs none of these files — so
 * without this block the rule has zero automated coverage anywhere.
 */
function stubProgramsResponse(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () => ({ ok: status < 300, status, json: async () => body }) as unknown as Response
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pages the programs collection the way the API would, at its real page size. */
function stubProgramsPages(all: unknown[], pageSize = 100) {
  const fetchMock = vi.fn(async (input: string) => {
    const params = new URL(input, "https://sdp.test").searchParams;
    const page = Number(params.get("page") ?? "1");
    const size = Number(params.get("pageSize") ?? "20");
    const slice = all.slice((page - 1) * size, page * size);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { programs: slice, total: all.length } }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pageSize };
}

function programFixture(id: string, status = "ready") {
  return {
    id,
    provider: "ground",
    label: null,
    createdAt: TIMESTAMP,
    wallet: {
      providerWalletRef: `${id}-ref`,
      status,
      balance: { totalUsd: "1", withdrawableUsd: "1", reservedUsd: "0", earnedUsd: "0" },
      positions: [],
      allocations: {},
    },
  };
}

describe("fetchEarnProgramsState", () => {
  it("maps an EMPTY list to no programs, not to an error", async () => {
    stubProgramsResponse(200, { data: { programs: [], total: 0 } });
    const state = await fetchEarnProgramsState();
    expect(state).toEqual({ kind: "ready", programs: [] });
    expect(hasPrograms(state)).toBe(false);
  });

  it("keeps every program, in the order the API returned them", async () => {
    stubProgramsResponse(200, {
      data: { programs: [programFixture("p1"), programFixture("p2")], total: 2 },
    });
    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(hasPrograms(state)).toBe(true);
    // Order is load-bearing: consumers that track one program across polls rely
    // on the head of this list being stable.
    expect(state.programs.map((program) => program.id)).toEqual(["p1", "p2"]);
  });

  it("maps 503 to unconfigured so the quiet provider notice stays reachable", async () => {
    stubProgramsResponse(503, { error: { message: "provider not configured" } });
    expect(await fetchEarnProgramsState()).toEqual({ kind: "unconfigured" });
  });

  /**
   * A 404 must NOT read as "no programs". A retired path, a typo'd proxy path,
   * or a missing Next route all answer 404, and mapping that to emptiness would
   * show onboarding to a customer whose funds are deployed.
   */
  it("throws on 404 rather than reporting an empty portfolio", async () => {
    stubProgramsResponse(404, { error: { message: "not found" } });
    await expect(fetchEarnProgramsState()).rejects.toThrow("not found");
  });

  it("throws on a server error", async () => {
    stubProgramsResponse(500, { error: { message: "boom" } });
    await expect(fetchEarnProgramsState()).rejects.toThrow("boom");
  });
});

describe("fetchEarnProgramsState pagination", () => {
  /**
   * The regression this pins: a single unpaged request silently truncates the
   * org's programs at the API's page window — and a hidden program is hidden
   * MONEY (totals under-report, its card never renders, its deep links stop
   * resolving). Same rule fetchEarnStrategies already enforces.
   */
  it("fetches every page, not just the first", async () => {
    const all = Array.from({ length: 205 }, (_, index) => programFixture(`p${index}`));
    const { fetchMock } = stubProgramsPages(all);

    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.programs).toHaveLength(205);
    expect(state.programs[204]?.id).toBe("p204");
    // 100-per-page over 205 programs = 3 requests.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after one request when a single page holds everything", async () => {
    const { fetchMock } = stubProgramsPages([programFixture("p0")]);
    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.programs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than returning a partial portfolio at the safety limit", async () => {
    const page = Array.from({ length: 100 }, (_, index) => programFixture(`p${index}`));
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { programs: page, total: Number.MAX_SAFE_INTEGER } }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnProgramsState()).rejects.toThrow(
      "Earn programs pagination exceeded its safety limit"
    );
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});

describe("fetchEarnProgramDeposits (via useEarnProgramDeposits fetcher)", () => {
  /**
   * No 404→empty mapping: the program id always comes from a program resolved
   * through the live list in this org+environment, so a 404 can only be a
   * broken proxy path or a scoping regression — and rendering that as "no
   * deposits yet" on a funded program would mask the bug as calm.
   */
  it("throws on 404 rather than reporting an empty feed", async () => {
    stubProgramsResponse(404, { error: { message: "not found" } });
    await expect(fetchEarnProgramDeposits("prog_1")).rejects.toThrow("not found");
  });
});

function withdrawalRecord(
  id: string,
  status: EarnProgramWithdrawalRecordStatus = "processing"
): EarnProgramWithdrawalRecord {
  return {
    id,
    provider: "ground",
    status,
    amountRequestedUsd: "10",
    token: "usdc",
    destinationAddress: "11111111111111111111111111111111",
    withdrawalRef: `${id}-provider-ref`,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

describe("fetchEarnProgramWithdrawals", () => {
  it("reads every ledger page and preserves every provider record", async () => {
    const all = Array.from({ length: 205 }, (_, index) => withdrawalRecord(`w${index}`));
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input, "https://sdp.test");
      const page = Number(url.searchParams.get("page"));
      const pageSize = Number(url.searchParams.get("pageSize"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            withdrawals: all.slice((page - 1) * pageSize, page * pageSize),
            total: all.length,
            page,
            pageSize,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const withdrawals = await fetchEarnProgramWithdrawals("program/one");

    expect(withdrawals).toHaveLength(205);
    expect(withdrawals[204]?.withdrawalRef).toBe("w204-provider-ref");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/dashboard/markets/earn/programs/program%2Fone/withdrawals?page=1&pageSize=100"
    );
    expect(fetchMock.mock.calls[2]?.[0]).toContain("page=3&pageSize=100");
  });

  it("fails closed instead of returning a partial ledger", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            withdrawals: [withdrawalRecord("only")],
            total: 2,
            page: 1,
            pageSize: 100,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnProgramWithdrawals("program_1")).rejects.toThrow(
      "Earn withdrawal ledger pagination ended before the reported total"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a page response that does not match the requested window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { withdrawals: [], total: 0, page: 2, pageSize: 100 },
          }),
        } as unknown as Response;
      })
    );

    await expect(fetchEarnProgramWithdrawals("program_1")).rejects.toThrow(
      "Earn withdrawal ledger pagination did not match the requested page"
    );
  });

  it("throws rather than returning a ledger prefix at the safety limit", async () => {
    const ledgerPage = Array.from({ length: 100 }, (_, index) => withdrawalRecord(`w${index}`));
    const fetchMock = vi.fn(async (input: string) => {
      const page = Number(new URL(input, "https://sdp.test").searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            withdrawals: ledgerPage,
            total: Number.MAX_SAFE_INTEGER,
            page,
            pageSize: 100,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEarnProgramWithdrawals("program_1")).rejects.toThrow(
      "Earn withdrawal ledger pagination exceeded its safety limit"
    );
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});

describe("earnProgramsRefreshInterval", () => {
  const withStatus = (...statuses: string[]) =>
    ({
      kind: "ready" as const,
      programs: statuses.map((status, index) => programFixture(`p${index}`, status)),
    }) as never;

  it("keeps provider-live balances fresh after programs settle", () => {
    expect(earnProgramsRefreshInterval(withStatus("ready", "ready"))).toBe(30_000);
  });

  it("polls at the FASTEST cadence any single program asks for", () => {
    // A `creating` program among settled ones must still converge on its
    // deposit address; taking the first program's cadence would strand it.
    expect(earnProgramsRefreshInterval(withStatus("ready", "creating"))).toBe(4_000);
    expect(earnProgramsRefreshInterval(withStatus("busy", "creating"))).toBe(4_000);
    expect(earnProgramsRefreshInterval(withStatus("ready", "busy"))).toBe(10_000);
  });

  it("does not poll before the read resolves", () => {
    expect(earnProgramsRefreshInterval(undefined)).toBe(0);
  });
});
