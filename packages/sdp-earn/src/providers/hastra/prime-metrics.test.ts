import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { SdpEarnError } from "../../errors";
import {
  HASTRA_POR_API_URL,
  hastraPercentToDecimalString,
  readHastraPrimeMetrics,
} from "./prime-metrics";

const PRIME_MINT = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";

const LIVE_BODY = {
  timestamp: "2026-09-22T21:44:02.027138016Z",
  wylds_card: {
    wylds_ratio: "1.0050906525492219",
  },
  prime_card: {
    mint_address_by_chain: {
      ethereum: "0x19ebb35279A16207Ec4ba82799CC64715065F7F6",
      solana: PRIME_MINT,
    },
    vaulted_wylds: "574514343.162077",
    vault_balance_by_chain: {
      ethereum: "443899131.432984",
      solana: "130615211.729093",
    },
  },
  demo_prime_card: {
    tokens: [
      { token: "auto", effective_rate: "7.4508" },
      { token: "prime", effective_rate: "6.1336" },
    ],
  },
};

function stubFeed(body: unknown, status = 200) {
  const seen: { url: string; method: string | undefined }[] = [];
  mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

afterEach(() => mock.restoreAll());

describe("hastraPercentToDecimalString", () => {
  it("shifts percent strings exactly without floating-point rounding", () => {
    assert.equal(hastraPercentToDecimalString("6.1336"), "0.061336");
    assert.equal(hastraPercentToDecimalString("6.1336999"), "0.061336");
    assert.equal(hastraPercentToDecimalString("3.5"), "0.035");
    assert.equal(hastraPercentToDecimalString("100"), "1");
    assert.equal(hastraPercentToDecimalString("0.00001"), "0");
    assert.equal(hastraPercentToDecimalString("6.1300"), "0.0613");
    assert.equal(hastraPercentToDecimalString("0"), "0");
  });

  it("refuses non-canonical or negative values", () => {
    for (const bad of [6.1336, "-1", "6e0", "06.1", " 6.1", "", null, undefined]) {
      assert.throws(() => hastraPercentToDecimalString(bad), SdpEarnError);
    }
  });
});

describe("readHastraPrimeMetrics", () => {
  it("reads PRIME APY and converts the Solana-only wYLDS balance to USD", async () => {
    const seen = stubFeed(LIVE_BODY);

    assert.deepEqual(await readHastraPrimeMetrics(PRIME_MINT), {
      providerReference: PRIME_MINT,
      currentApy: "0.061336",
      solanaTvlUsd: 131_280_128.38964885,
    });
    assert.deepEqual(seen, [{ url: HASTRA_POR_API_URL, method: "GET" }]);
  });

  it("refuses a feed whose Solana PRIME mint differs from the admitted deployment", async () => {
    stubFeed({
      ...LIVE_BODY,
      prime_card: {
        ...LIVE_BODY.prime_card,
        mint_address_by_chain: { solana: "11111111111111111111111111111111" },
      },
    });

    await assert.rejects(
      readHastraPrimeMetrics(PRIME_MINT),
      (error: unknown) => error instanceof SdpEarnError && error.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("refuses a missing, duplicate, or malformed PRIME metrics entry", async () => {
    for (const tokens of [
      [{ token: "auto", effective_rate: "7.4508" }],
      [
        { token: "prime", effective_rate: "6.1336" },
        { token: "prime", effective_rate: "6.2" },
      ],
      [{ token: "prime", effective_rate: 6.1336 }],
    ]) {
      stubFeed({ ...LIVE_BODY, demo_prime_card: { tokens } });
      await assert.rejects(readHastraPrimeMetrics(PRIME_MINT), SdpEarnError);
      mock.restoreAll();
    }
  });

  it("refuses a malformed Solana TVL instead of substituting the cross-chain total", async () => {
    stubFeed({
      ...LIVE_BODY,
      prime_card: {
        ...LIVE_BODY.prime_card,
        vault_balance_by_chain: { solana: -1 },
      },
    });

    await assert.rejects(readHastraPrimeMetrics(PRIME_MINT), SdpEarnError);
  });

  it("refuses a missing or malformed wYLDS USD ratio instead of publishing token units", async () => {
    for (const wyldsRatio of [undefined, -1, "0", "not-a-decimal"]) {
      stubFeed({
        ...LIVE_BODY,
        wylds_card: { wylds_ratio: wyldsRatio },
      });
      await assert.rejects(readHastraPrimeMetrics(PRIME_MINT), SdpEarnError);
      mock.restoreAll();
    }
  });

  it("surfaces upstream HTTP failures through the provider error taxonomy", async () => {
    stubFeed({ error: "upstream" }, 502);
    await assert.rejects(
      readHastraPrimeMetrics(PRIME_MINT),
      (error: unknown) => error instanceof SdpEarnError && error.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("surfaces rate limits as RATE_LIMITED so the next refresh can retry", async () => {
    stubFeed({ error: "too many requests" }, 429);
    await assert.rejects(
      readHastraPrimeMetrics(PRIME_MINT),
      (error: unknown) => error instanceof SdpEarnError && error.code === "RATE_LIMITED"
    );
  });
});
