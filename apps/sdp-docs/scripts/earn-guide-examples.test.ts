import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { EarnStrategy } from "@sdp/types/earn";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { z } from "zod";

const content = fileURLToPath(new URL("../content/docs/earn/", import.meta.url));
const API = "https://api.solana.com";
const USDC = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const OWNER = "test-owner";
const CUSTODY_ADDRESS = "test-custody-address";

type Strategy = Pick<
  EarnStrategy,
  "id" | "status" | "fundable" | "depositMints" | "depositSlippage" | "withdrawalSlippage"
>;
const eligible: Strategy = {
  id: "usdc-strategy",
  status: "active",
  fundable: true,
  depositMints: [USDC],
  depositSlippage: null,
  withdrawalSlippage: null,
};
const wrongMint: Strategy = { ...eligible, id: "other-token", depositMints: ["other-mint"] };
const secondaryUsdc: Strategy = {
  ...eligible,
  id: "usdc-is-not-the-deposit-token",
  depositMints: ["other-mint", USDC],
};
const needsFloor: Strategy = {
  ...eligible,
  id: "usdc-with-a-floor",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
};

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body: unknown };
const callInitSchema = z
  .object({
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  })
  .optional();

/** A `fetch` double that records each API call and answers it from `reply`. */
function fakeFetch(reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: unknown) => {
    assert.ok(url.startsWith(`${API}/v1/`), `Unexpected request: ${url}`);
    const request = callInitSchema.parse(init);
    const call: Call = {
      method: request?.method ?? "GET",
      path: url.slice(API.length),
      headers: request?.headers ?? {},
      body: request?.body === undefined ? undefined : JSON.parse(request.body),
    };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetch };
}

/** Every TypeScript block of a page's example file, in page order, as one script. */
async function example(page: string, file: string): Promise<string> {
  const source = await fs.readFile(path.join(content, `${page}.mdx`), "utf8");
  const blocks = [...source.matchAll(/```typescript title="([^"]+)"\n([\s\S]*?)```/g)]
    .filter((match) => match[1] === file || match[1] === `${file} (continued)`)
    .map((match) => match[2]);
  assert.ok(blocks.length > 0, `Missing ${file} in ${page}`);
  return blocks.join("\n");
}

/** Execute an authored example with request and wallet doubles. */
async function runExample<Schema extends z.ZodType>(
  source: string,
  globals: Record<string, unknown>,
  result: string,
  schema: Schema
): Promise<z.output<Schema>> {
  const script = source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
  const compiled = transpileModule(script, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  });
  const evaluated: unknown = await runInNewContext(
    `(async () => {\n${compiled.outputText}\nreturn ${result};\n})()`,
    { URLSearchParams, process: { env: { SDP_API_KEY: "test-key" } }, ...globals }
  );
  return schema.parse(evaluated);
}

/** Wallet, clock and console doubles for the Quickstart's `deposit.ts`. */
function quickstartGlobals(fetch: unknown): Record<string, unknown> {
  return {
    fetch,
    console: { log: () => undefined },
    randomUUID: () => "test-idempotency-key",
    readFile: async () => "[1, 2, 3]",
    setTimeout: (resume: () => void) => resume(),
    createKeyPairFromBytes: async () => ({ publicKey: "test-public-key" }),
    getAddressFromPublicKey: async () => OWNER,
    getBase64Encoder: () => ({ encode: (base64: string) => `bytes:${base64}` }),
    getTransactionDecoder: () => ({ decode: (bytes: string) => `decoded:${bytes}` }),
    partiallySignTransaction: async (_signers: unknown, transaction: string) =>
      `signed:${transaction}`,
    getBase64EncodedWireTransaction: (transaction: string) => `wire:${transaction}`,
  };
}

/** The Earn API as the Quickstart meets it: one deposit that finalizes on its second read. */
function quickstartApi(strategies: Strategy[], build: Reply = { body: buildReply }) {
  let movementReads = 0;
  return fakeFetch(({ path: route }) => {
    if (route.startsWith("/v1/earn/strategies")) return { body: { data: { strategies } } };
    if (route === "/v1/earn/external-wallet/deposit-transactions") return build;
    if (route === "/v1/earn/external-wallet/deposits") {
      return { body: { data: { deposit: { movementId: "movement", positionId: "position" } } } };
    }
    if (route === "/v1/earn/external-wallet/movements/movement") {
      movementReads += 1;
      const status = movementReads < 2 ? "submitted" : "finalized";
      return { body: { data: { movement: { status } } } };
    }
    if (route.startsWith("/v1/earn/external-wallet/positions?")) {
      return { body: { data: { positions: [{ id: "position" }] } } };
    }
    throw new Error(`Unexpected request: ${route}`);
  });
}
const buildReply = {
  data: { transaction: { transactionId: "build", transaction: "unsigned" } },
};
const depositResultSchema = z.object({
  strategy: z.object({ id: z.string() }),
  movement: z.object({ status: z.string() }),
  positions: z.array(z.object({ id: z.string() })),
});

/** Clock, console and environment doubles for the Treasury quickstart's `deposit.mts`. */
function treasuryGlobals(fetch: unknown): Record<string, unknown> {
  return {
    fetch,
    console: { log: () => undefined },
    randomUUID: () => "test-idempotency-key",
    setTimeout: (resume: () => void) => resume(),
    process: { env: { SDP_API_KEY: "test-key", WALLET: CUSTODY_ADDRESS } },
  };
}

const custodyWallets = [
  { id: "another-wallet", publicKey: "another-address" },
  { id: "treasury-wallet", publicKey: CUSTODY_ADDRESS },
];

/** The API as the Treasury quickstart meets it: one custody deposit that confirms on its second read. */
function treasuryApi(
  strategies: Strategy[],
  wallets = custodyWallets,
  deposit: Reply = { body: { data: { movementId: "movement", positionId: "position" } } }
) {
  let depositReads = 0;
  return fakeFetch(({ method, path: route }) => {
    if (route.startsWith("/v1/earn/strategies")) return { body: { data: { strategies } } };
    if (route === "/v1/wallets") return { body: { data: { wallets } } };
    if (route === "/v1/earn/vault-deposits" && method === "POST") return deposit;
    if (route === "/v1/earn/vault-deposits/movement") {
      depositReads += 1;
      const status = depositReads < 2 ? "submitted" : "confirmed";
      return { body: { data: { deposit: { status } } } };
    }
    if (route === "/v1/earn/vault-positions") {
      return { body: { data: { positions: [{ id: "position" }] } } };
    }
    throw new Error(`Unexpected request: ${method} ${route}`);
  });
}
const treasuryResultSchema = z.object({
  strategy: z.object({ id: z.string() }),
  record: z.object({ status: z.string() }),
  positions: z.array(z.object({ id: z.string() })),
});

describe("Earn guide examples", () => {
  it("quickstart deposits into the strategy whose deposit token is the funded USDC", async () => {
    const source = await example("quickstart", "deposit.ts");
    const api = quickstartApi([wrongMint, secondaryUsdc, needsFloor, eligible]);
    const result = await runExample(
      source,
      quickstartGlobals(api.fetch),
      "{ strategy, movement, positions }",
      depositResultSchema
    );
    assert.equal(result.strategy.id, eligible.id);
    assert.equal(result.movement.status, "finalized");
    assert.deepEqual(result.positions, [{ id: "position" }]);

    for (const call of api.calls) assert.equal(call.headers.Authorization, "Bearer test-key");
    const build = api.calls.find(({ path: route }) => route.endsWith("/deposit-transactions"));
    assert.deepEqual(build?.body, { strategyId: eligible.id, ownerAddress: OWNER, amount: "10" });
    assert.equal(build?.headers["Idempotency-Key"], undefined);
    const submit = api.calls.find(({ path: route }) => route.endsWith("/deposits"));
    assert.deepEqual(submit?.body, {
      transactionId: "build",
      signedTransaction: "wire:signed:decoded:bytes:unsigned",
    });
    assert.equal(submit?.headers["Idempotency-Key"], "test-idempotency-key");
    assert.equal(api.calls.filter(({ path: route }) => route.includes("/movements/")).length, 2);
    assert.ok(
      api.calls.some(({ path: route }) => route.endsWith(`/positions?ownerAddress=${OWNER}`))
    );
  });

  it("quickstart stops when no funded USDC strategy is available", async () => {
    const source = await example("quickstart", "deposit.ts");
    const api = quickstartApi([wrongMint, secondaryUsdc, needsFloor]);
    await assert.rejects(
      runExample(source, quickstartGlobals(api.fetch), "strategy", z.unknown()),
      /No devnet USDC strategy is open for deposits/
    );
    assert.equal(api.calls.length, 1);
  });

  it("quickstart reports the API's own error when a build is refused", async () => {
    const source = await example("quickstart", "deposit.ts");
    const api = quickstartApi([eligible], {
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Kamino requires manual activation for this organization.",
          details: { reason: "provider_not_entitled" },
        },
      },
    });
    await assert.rejects(
      runExample(source, quickstartGlobals(api.fetch), "strategy", z.unknown()),
      /FORBIDDEN: Kamino requires manual activation for this organization\./
    );
    assert.equal(
      api.calls.some(({ path: route }) => route.endsWith("/deposits")),
      false
    );
  });

  for (const page of ["quickstart", "treasury-quickstart"]) {
    it(`${page} tabs lead with TypeScript and hold one code block each`, async () => {
      // A tab with prose or a second block makes its whole group render a nested frame per block.
      const source = await fs.readFile(path.join(content, `${page}.mdx`), "utf8");
      const groups = [
        ...source.matchAll(/<Tabs items=\{(\[[^\]]*\])\}[^>]*>\n([\s\S]*?)\n<\/Tabs>/g),
      ];
      assert.ok(groups.length > 0);
      for (const [, items, body] of groups) {
        assert.deepEqual(JSON.parse(items ?? "[]"), ["TypeScript", "cURL"]);
        const panels = [...(body ?? "").matchAll(/<Tab value="[^"]+">\n([\s\S]*?)\n<\/Tab>/g)];
        assert.equal(panels.length, 2);
        for (const [, panel] of panels) {
          assert.match((panel ?? "").trim(), /^```[^\n]*\n[\s\S]*?\n```$/, panel);
          assert.equal((panel ?? "").match(/^```/gm)?.length, 2, panel);
        }
      }
    });
  }

  it("quickstart cURL and TypeScript call the same endpoints", async () => {
    const source = await fs.readFile(path.join(content, "quickstart.mdx"), "utf8");
    const routeOf = (route: string) =>
      route.replace(/\?.*$/, "").replace(/\/movements\/.+$/, "/movements/{movementId}");
    const curlRoutes = [...source.matchAll(/```bash title="Terminal"\n([\s\S]*?)```/g)]
      .flatMap((block) => [
        ...(block[1] ?? "").matchAll(/https:\/\/api\.solana\.com(\/v1\/[^\s"]+)/g),
      ])
      .map((match) => routeOf(match[1] ?? ""));
    const api = quickstartApi([eligible]);
    await runExample(
      await example("quickstart", "deposit.ts"),
      quickstartGlobals(api.fetch),
      "movement",
      z.unknown()
    );
    assert.deepEqual(
      [...new Set(api.calls.map(({ path: route }) => routeOf(route)))],
      [...new Set(curlRoutes)]
    );
  });

  it("treasury quickstart deposits from the custody wallet the address names", async () => {
    const source = await example("treasury-quickstart", "deposit.mts");
    const api = treasuryApi([wrongMint, secondaryUsdc, needsFloor, eligible]);
    const result = await runExample(
      source,
      treasuryGlobals(api.fetch),
      "{ strategy, record, positions }",
      treasuryResultSchema
    );
    assert.equal(result.strategy.id, eligible.id);
    assert.equal(result.record.status, "confirmed");
    assert.deepEqual(result.positions, [{ id: "position" }]);

    for (const call of api.calls) assert.equal(call.headers.Authorization, "Bearer test-key");
    const deposit = api.calls.find(({ method }) => method === "POST");
    assert.equal(deposit?.path, "/v1/earn/vault-deposits");
    assert.deepEqual(deposit?.body, {
      strategyId: eligible.id,
      custodyWalletId: "treasury-wallet",
      amount: "10",
    });
    // SDP signs, so the deposit is the only request that moves money and the only one keyed.
    assert.deepEqual(
      api.calls.filter((call) => call.headers["Idempotency-Key"] !== undefined),
      [deposit]
    );
    assert.equal(
      api.calls.filter(({ path: route }) => route === "/v1/earn/vault-deposits/movement").length,
      2
    );
  });

  it("treasury quickstart stops before depositing when the key cannot see the wallet", async () => {
    const source = await example("treasury-quickstart", "deposit.mts");
    const api = treasuryApi([eligible], [{ id: "another-wallet", publicKey: "another-address" }]);
    await assert.rejects(
      runExample(source, treasuryGlobals(api.fetch), "strategy", z.unknown()),
      /This API key cannot see that wallet/
    );
    assert.equal(
      api.calls.some(({ method }) => method === "POST"),
      false
    );
  });

  it("treasury quickstart reports the API's own error when a deposit is refused", async () => {
    const source = await example("treasury-quickstart", "deposit.mts");
    const api = treasuryApi([eligible], custodyWallets, {
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "The credential may not sign with this wallet",
          details: { reason: "wallet_out_of_scope" },
        },
      },
    });
    await assert.rejects(
      runExample(source, treasuryGlobals(api.fetch), "strategy", z.unknown()),
      /FORBIDDEN: The credential may not sign with this wallet/
    );
    assert.equal(
      api.calls.some(({ path: route }) => route.startsWith("/v1/earn/vault-deposits/")),
      false
    );
  });

  it("treasury quickstart cURL and TypeScript call the same endpoints", async () => {
    const source = await fs.readFile(path.join(content, "treasury-quickstart.mdx"), "utf8");
    const routeOf = (route: string) =>
      route.replace(/\?.*$/, "").replace(/\/vault-deposits\/.+$/, "/vault-deposits/{movementId}");
    const curlRoutes = [...source.matchAll(/```bash title="Terminal"\n([\s\S]*?)```/g)]
      .flatMap((block) => [
        ...(block[1] ?? "").matchAll(/https:\/\/api\.solana\.com(\/v1\/[^\s"]+)/g),
      ])
      .map((match) => routeOf(match[1] ?? ""));
    const api = treasuryApi([eligible]);
    await runExample(
      await example("treasury-quickstart", "deposit.mts"),
      treasuryGlobals(api.fetch),
      "record",
      z.unknown()
    );
    assert.deepEqual(
      [...new Set(api.calls.map(({ path: route }) => routeOf(route)))],
      [...new Set(curlRoutes)]
    );
  });

  for (const withdrawalSlippage of [null, { defaultToleranceBps: 10 }]) {
    it(`treasury withdraws a saved custody position with its ${withdrawalSlippage ? "floor" : "floorless"} policy`, async () => {
      const source = await example("treasury", "withdraw.ts");
      const floorCalls: [string, number, number][] = [];
      const saved = { positionId: "saved-position", withdrawalSlippage };
      const api = fakeFetch(({ path: route }) => {
        // An exit never needs the catalog: the strategy may be delisted.
        assert.doesNotMatch(route, /\/strategies/);
        if (route.endsWith("/vault-withdrawal-options"))
          return { body: { data: { instant: true } } };
        if (route.endsWith("/vault-withdrawal-previews")) {
          return { body: { data: { assetsOut: "10", assetDecimals: 6, blockingIssues: [] } } };
        }
        if (route.endsWith("/vault-withdrawals")) {
          return { body: { data: { withdrawal: { movementId: "movement" } } } };
        }
        throw new Error(`Unexpected request: ${route}`);
      });
      const withdrawal = await runExample(
        source,
        {
          saved,
          fetch: api.fetch,
          randomUUID: () => "test-idempotency-key",
          floorForTolerance: (amount: string, decimals: number, toleranceBps: number) => {
            floorCalls.push([amount, decimals, toleranceBps]);
            return "9.99";
          },
        },
        'await withdraw(saved, "10")',
        z.object({ movementId: z.string() })
      );
      assert.equal(withdrawal.movementId, "movement");
      assert.deepEqual(
        api.calls.map(({ path: route }) => route),
        [
          "/v1/earn/vault-withdrawal-options",
          "/v1/earn/vault-withdrawal-previews",
          "/v1/earn/vault-withdrawals",
        ]
      );
      const submit = api.calls.at(-1);
      assert.deepEqual(submit?.body, {
        positionId: saved.positionId,
        shares: "10",
        ...(withdrawalSlippage ? { minAmountOut: "9.99" } : {}),
      });
      assert.deepEqual(floorCalls, withdrawalSlippage ? [["10", 6, 10]] : []);
      // SDP signs the withdrawal, so only it carries an idempotency key.
      assert.deepEqual(
        api.calls.filter((call) => call.headers["Idempotency-Key"] !== undefined),
        [submit]
      );
    });
  }

  it("treasury withdraw stops when the position has no instant route", async () => {
    const source = await example("treasury", "withdraw.ts");
    const api = fakeFetch(({ path: route }) => {
      if (route.endsWith("/vault-withdrawal-options"))
        return { body: { data: { instant: false } } };
      throw new Error(`Unexpected request: ${route}`);
    });
    await assert.rejects(
      runExample(
        source,
        {
          saved: { positionId: "saved-position", withdrawalSlippage: null },
          fetch: api.fetch,
          randomUUID: () => "test-idempotency-key",
          floorForTolerance: () => "9.99",
        },
        'await withdraw(saved, "10")',
        z.unknown()
      ),
      /No instant route/
    );
    assert.equal(api.calls.length, 1);
  });

  for (const withdrawalSlippage of [null, { defaultToleranceBps: 10 }]) {
    it(`withdraws a delisted position with its saved ${withdrawalSlippage ? "floor" : "floorless"} policy`, async () => {
      const source = await example("withdrawals", "withdraw.ts");
      const floorCalls: [string, number, number][] = [];
      const saved = { positionId: "saved-position", ownerAddress: OWNER, withdrawalSlippage };
      const api = fakeFetch(({ path: route }) => {
        // An exit never needs the catalog: the position may be delisted.
        assert.doesNotMatch(route, /\/strategies/);
        if (route.startsWith("/v1/earn/external-wallet/positions?")) {
          const query = new URL(route, API).searchParams;
          assert.equal(query.get("ownerAddress"), OWNER);
          if (query.get("before") === null) {
            const positions = [{ id: "newer-position", withdrawableShares: "10" }];
            return { body: { data: { positions, nextCursor: "older-positions" } } };
          }
          assert.equal(query.get("before"), "older-positions");
          const positions = [{ id: saved.positionId, withdrawableShares: "10" }];
          return { body: { data: { positions, nextCursor: null } } };
        }
        if (route.endsWith("/withdrawal-previews")) {
          return { body: { data: { assetsOut: "10", assetDecimals: 6, blockingIssues: [] } } };
        }
        if (route.endsWith("/withdrawal-transactions")) return { body: buildReply };
        if (route.endsWith("/withdrawals")) {
          return { body: { data: { withdrawal: { movementId: "movement" } } } };
        }
        throw new Error(`Unexpected request: ${route}`);
      });
      const withdrawal = await runExample(
        source,
        {
          saved,
          fetch: api.fetch,
          randomUUID: () => "test-idempotency-key",
          sign: async (transaction: string) => `signed:${transaction}`,
          floorForTolerance: (amount: string, decimals: number, toleranceBps: number) => {
            floorCalls.push([amount, decimals, toleranceBps]);
            return "9.99";
          },
        },
        'await withdraw(saved, "10", sign)',
        z.object({ movementId: z.string() })
      );
      assert.equal(withdrawal.movementId, "movement");
      assert.equal(api.calls.filter(({ path: route }) => route.includes("/positions?")).length, 2);
      const build = api.calls.find(({ path: route }) => route.endsWith("/withdrawal-transactions"));
      assert.deepEqual(build?.body, {
        positionId: saved.positionId,
        shares: "10",
        ...(withdrawalSlippage ? { minAmountOut: "9.99" } : {}),
      });
      assert.deepEqual(floorCalls, withdrawalSlippage ? [["10", 6, 10]] : []);
      const submit = api.calls.find(({ path: route }) => route.endsWith("/withdrawals"));
      assert.deepEqual(submit?.body, {
        transactionId: "build",
        signedTransaction: "signed:unsigned",
      });
      // Only the submit moves money, so only it carries an idempotency key.
      assert.deepEqual(
        api.calls.filter((call) => call.headers["Idempotency-Key"] !== undefined),
        [submit]
      );
    });
  }
});
