import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { operationIntentSchema, submitOperationSchema } from "@sdp/types/operations";

/**
 * Every JSON block on these pages is titled: a request body, parsed by the
 * schema the API uses, or a named response sample.
 */
const examples = [
  {
    page: "quickstart",
    requests: [
      {
        path: "/v1/earn/deposit",
        title: "deposit.json",
        schema: operationIntentSchema.options[0].omit({ kind: true }),
      },
      {
        path: "/v1/operations/{operationId}/submit",
        title: "submission.json",
        schema: submitOperationSchema,
      },
    ],
    responses: ["202 response (trimmed)"],
  },
  {
    page: "api-overview",
    requests: [],
    responses: ["Strategy (trimmed)", "Position (trimmed)", "Operation (trimmed)"],
  },
  {
    page: "withdrawals",
    requests: [
      {
        path: "/v1/earn/withdraw",
        title: "withdrawal.json",
        schema: operationIntentSchema.options[1].omit({ kind: true }),
      },
    ],
    responses: [],
  },
] as const;

describe("Earn core guide examples", () => {
  for (const { page, requests, responses } of examples) {
    it(`${page} uses valid requests for each documented operation`, async () => {
      const source = await readFile(
        new URL(`../content/docs/earn/${page}.mdx`, import.meta.url),
        "utf8"
      );
      const blocks = [
        ...source.matchAll(/```json(?:[ \t]+title="([^"]*)")?[^\n]*\n([\s\S]*?)```/g),
      ];
      assert.deepEqual(
        blocks.map(([, title]) => title ?? "untitled").sort(),
        [...requests.map(({ title }) => title), ...responses].sort(),
        "Every JSON block is a validated request or a named response"
      );
      for (const { path, title, schema } of requests) {
        assert.ok(source.includes(`POST ${path}`), `Expected documented POST ${path}`);
        const body = blocks.find(([, blockTitle]) => blockTitle === title)?.[2] ?? "";
        // Replace only the documented placeholder; keep the base64 validator active.
        schema.parse(JSON.parse(body.replaceAll("<base64-signed-transaction>", "AQ==")));
      }
    });
  }
});
