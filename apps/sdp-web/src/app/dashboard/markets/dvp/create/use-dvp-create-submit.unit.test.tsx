// @vitest-environment jsdom
/**
 * The create request, and above all its idempotency key.
 *
 * The key has to do two opposite things: make a retry of the same request a
 * replay, and make a second trade on identical terms a new request. The
 * server fingerprint guards the key against reuse with different terms; the
 * client's only job is to hand each logical request exactly one key.
 */
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpCreateRequest } from "./use-dvp-create-submit";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";

// Submitting confirms in words, so the hook needs the catalog they come from.
function withI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const T22 = SPL_TOKEN_PROGRAMS["token-2022"];
const WALLET_A = "cwlt_a";
const ADDRESS_A = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const ADDRESS_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

function request(overrides: Partial<DvpCreateRequest> = {}): DvpCreateRequest {
  return {
    parties: {
      a: { ref: { walletId: WALLET_A }, address: ADDRESS_A },
      b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
    },
    amountA: "1000",
    amountB: "2000",
    expiry: "2027-01-01T23:59",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    refString: "",
    tokenProgramA: T22,
    tokenProgramB: T22,
    // Empty is the ordinary trade: each party is paid at its own address.
    userASettlementDestination: "",
    userBSettlementDestination: "",
    ...overrides,
  };
}

/** Submits once and reports the request that went out. */
async function requestFor(overrides: Partial<DvpCreateRequest> = {}): Promise<{
  idempotencyKey: string;
  body: Record<string, unknown>;
}> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { trade: { id: "dvp_1" } } }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useDvpCreateSubmit(), { wrapper: withI18n });
  await act(async () => {
    await result.current.submit(request(overrides));
  });

  const call = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string>; body?: string };
  return {
    idempotencyKey: call.headers?.["Idempotency-Key"] ?? "",
    body: call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {},
  };
}

describe("useDvpCreateSubmit wire shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the party slots as their wire refs, exactly", async () => {
    const { body } = await requestFor();

    expect(body.partyA).toEqual({ walletId: WALLET_A });
    expect(body.partyB).toEqual({ address: ADDRESS_B });
  });

  it("sends a counterparty slot as its account id", async () => {
    const { body } = await requestFor({
      parties: {
        a: { ref: { counterpartyAccountId: "cpa_1" }, address: ADDRESS_A },
        b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
      },
    });

    expect(body.partyA).toEqual({ counterpartyAccountId: "cpa_1" });
  });

  it("omits empty settlement destinations rather than sending empty strings", async () => {
    const { body } = await requestFor();

    expect(body).not.toHaveProperty("userASettlementDestination");
    expect(body).not.toHaveProperty("userBSettlementDestination");
  });
});

describe("useDvpCreateSubmit idempotency key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function keyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
    const init = fetchMock.mock.calls[call]?.[1] as { headers?: Record<string, string> };
    return init.headers?.["Idempotency-Key"] ?? "";
  }

  it("is well formed", async () => {
    expect((await requestFor()).idempotencyKey).toMatch(/^dvp-create-[0-9a-f]{32}$/);
  });

  it("reuses the key when the request got no response, so the retry replays", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { trade: { id: "dvp_1" } } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDvpCreateSubmit(), { wrapper: withI18n });
    await act(async () => {
      await result.current.submit(request());
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(keyOf(fetchMock, 1)).toBe(keyOf(fetchMock, 0));
  });

  it.each([
    [
      "accepted",
      { ok: true, status: 200, json: async () => ({ data: { trade: { id: "dvp_1" } } }) },
    ],
    ["rejected", { ok: false, status: 400, json: async () => ({ error: { message: "no" } }) }],
  ])(
    "rotates the key once a response arrives (%s), so identical terms make a second trade",
    async (_label, response) => {
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useDvpCreateSubmit(), { wrapper: withI18n });
      await act(async () => {
        await result.current.submit(request());
      });
      await act(async () => {
        await result.current.submit(request());
      });

      expect(keyOf(fetchMock, 1)).not.toBe(keyOf(fetchMock, 0));
    }
  );
});
