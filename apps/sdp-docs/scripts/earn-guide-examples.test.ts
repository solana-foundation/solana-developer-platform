import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { operationIntentSchema, submitOperationSchema } from "@sdp/types/operations";

const examples = [
  {
    page: "quickstart",
    requests: [
      {
        path: "/v1/earn/deposit",
        schema: operationIntentSchema.options[0].omit({ kind: true }),
      },
      { path: "/v1/operations/{operationId}/submit", schema: submitOperationSchema },
    ],
  },
  {
    page: "withdrawals",
    requests: [
      {
        path: "/v1/earn/withdraw",
        schema: operationIntentSchema.options[1].omit({ kind: true }),
      },
    ],
  },
] as const;

describe("Earn core guide examples", () => {
  for (const { page, requests } of examples) {
    it(`${page} uses valid requests for each documented operation`, async () => {
      const source = await readFile(
        new URL(`../content/docs/earn/${page}.mdx`, import.meta.url),
        "utf8"
      );
      const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)];
      assert.equal(blocks.length, requests.length, "Validate every request example");
      for (const [index, { path, schema }] of requests.entries()) {
        assert.ok(source.includes(`POST ${path}`), `Expected documented POST ${path}`);
        // Replace only the documented placeholder; keep the base64 validator active.
        const body: unknown = JSON.parse(
          blocks[index][1].replaceAll("<base64-signed-transaction>", "AQ==")
        );
        schema.parse(body);
      }
    });
  }
});
