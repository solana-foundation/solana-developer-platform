import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { operationIntentSchema } from "@sdp/types/operations";

const examples = [
  { page: "quickstart", kind: "earn.deposit" },
  { page: "withdrawals", kind: "earn.withdraw" },
] as const;

describe("Earn core guide examples", () => {
  for (const { page, kind } of examples) {
    it(`${page} uses a valid shared intent with explicit amount units`, async () => {
      const source = await readFile(
        new URL(`../content/docs/earn/${page}.mdx`, import.meta.url),
        "utf8"
      );
      const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)];
      assert.ok(blocks.length > 0, "Expected a complete request example");
      for (const block of blocks) {
        const parsed: unknown = JSON.parse(block[1]);
        assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
        assert.equal(operationIntentSchema.safeParse({ kind, ...parsed }).success, true);
      }
    });
  }
});
