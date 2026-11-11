import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { EarnStrategy } from "@sdp/types/earn";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { z } from "zod";

const content = fileURLToPath(new URL("../content/docs/earn/", import.meta.url));
const USDC = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const selectedStrategySchema = z.object({ id: z.string() });
const finalizedMovementSchema = z.object({ status: z.literal("finalized") });
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

async function example(page: string, title: string): Promise<string> {
  const source = await fs.readFile(path.join(content, `${page}.mdx`), "utf8");
  const blocks = [...source.matchAll(/```typescript title="([^"]+)"\n([\s\S]*?)```/g)];
  const block = blocks.find((match) => match[1] === title)?.[2];
  assert.ok(block, `Missing ${title} in ${page}`);
  return block;
}

/** Execute the authored examples with local request and wallet doubles. */
async function runExample<Schema extends z.ZodType>(
  source: string,
  globals: Record<string, unknown>,
  result: string,
  schema: Schema
): Promise<z.output<Schema>> {
  const script = source.replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  const compiled = transpileModule(script, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  });
  const evaluated: unknown = await runInNewContext(
    `(async () => {\n${compiled.outputText}\nreturn ${result};\n})()`,
    { URLSearchParams, ...globals }
  );
  return schema.parse(evaluated);
}

describe("Earn guide examples", () => {
  for (const page of ["quickstart", "deposits"]) {
    it(`${page} chooses a strategy whose actual deposit token is funded USDC`, async () => {
      const source = await example(page, "deposit.ts");
      const result = await runExample(
        source,
        {
          earnRequest: async () => ({
            strategies: [wrongMint, secondaryUsdc, eligible],
            blockingIssues: [],
            transaction: {},
          }),
          ownerAddress: "test-owner",
        },
        "strategy",
        selectedStrategySchema
      );
      assert.equal(result.id, eligible.id);
    });

    it(`${page} stops when no funded USDC strategy is available`, async () => {
      const source = await example(page, "deposit.ts");
      await assert.rejects(
        runExample(
          source,
          { earnRequest: async () => ({ strategies: [wrongMint, secondaryUsdc] }) },
          "strategy",
          selectedStrategySchema
        ),
        /No devnet USDC strategy is open for deposits/
      );
    });
  }

  it("cURL selection chooses USDC and stops without an id when none matches", async () => {
    const source = await fs.readFile(path.join(content, "deposits.mdx"), "utf8");
    const start = source.indexOf('STRATEGY_ID="$(');
    const end = source.indexOf("export AMOUNT=", start);
    assert.ok(start >= 0 && end > start);
    const command = `${source.slice(start, end)}\nprintf '%s' "$STRATEGY_ID"`;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "earn-guide-selection-"));
    try {
      for (const [strategies, expectedId] of [
        [[wrongMint, secondaryUsdc, eligible], eligible.id],
        [[wrongMint, secondaryUsdc], null],
      ] as const) {
        await fs.writeFile(
          path.join(directory, "strategies.json"),
          JSON.stringify({ data: { strategies } })
        );
        const result = spawnSync("bash", ["-c", command], { cwd: directory, encoding: "utf8" });
        assert.ifError(result.error);
        if (expectedId === null) {
          assert.equal(result.status, 1);
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /No devnet USDC strategy is open for deposits/);
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout, expectedId);
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  for (const withdrawalSlippage of [null, { defaultToleranceBps: 10 }]) {
    it(`withdraws a delisted position with its saved ${withdrawalSlippage ? "floor" : "floorless"} policy`, async () => {
      const source = await example("withdrawals", "withdraw.ts");
      const calls: { route: string; body: Record<string, unknown> | undefined }[] = [];
      const floorCalls: [string, number, number][] = [];
      const savedPosition = { positionId: "saved-position", withdrawalSlippage };
      const movement = await runExample(
        source,
        {
          savedPosition,
          ownerAddress: "test-owner",
          randomUUID: () => "test-idempotency-key",
          signWithTestWallet: async () => "signed-transaction",
          floorForTolerance: (amount: string, decimals: number, toleranceBps: number) => {
            floorCalls.push([amount, decimals, toleranceBps]);
            return "9.99";
          },
          waitForMovement: async () => ({ status: "finalized" }),
          earnRequest: async (route: string, body?: Record<string, unknown>) => {
            assert.doesNotMatch(route, /\/strategies/);
            calls.push({ route, body });
            if (route.startsWith("/v1/earn/external-wallet/positions?")) {
              const query = new URL(route, "https://test.example").searchParams;
              if (query.get("before") === null) {
                return {
                  positions: [{ id: "newer-position", withdrawableShares: "10" }],
                  nextCursor: "older-positions",
                };
              }
              assert.equal(query.get("before"), "older-positions");
              return {
                positions: [{ id: savedPosition.positionId, withdrawableShares: "10" }],
                nextCursor: null,
              };
            }
            return {
              assetsOut: "10",
              assetDecimals: 6,
              blockingIssues: [],
              transaction: { transactionId: "build", transaction: "unsigned" },
              withdrawal: { movementId: "movement" },
            };
          },
        },
        'await withdraw(savedPosition, "10")',
        finalizedMovementSchema
      );
      assert.equal(movement.status, "finalized");
      assert.equal(calls.filter(({ route }) => route.includes("/positions?")).length, 2);
      const build = calls.find(({ route }) => route.endsWith("/withdrawal-transactions"));
      assert.ok(build?.body);
      assert.equal(build.body.positionId, savedPosition.positionId);
      assert.equal(build.body.minAmountOut, withdrawalSlippage ? "9.99" : undefined);
      assert.deepEqual(floorCalls, withdrawalSlippage ? [["10", 6, 10]] : []);
    });
  }
});
