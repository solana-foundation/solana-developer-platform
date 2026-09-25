import assert from "node:assert/strict";
import test from "node:test";

import {
  examplePathMatchesTemplate,
  extractCodeBlocks,
  extractIdempotencyPostPaths,
  findMissingIdempotencyKeyExamples,
  splitBlockIntoRequests,
} from "./lib/idempotency-examples.mjs";

const specWithOperationHeader = {
  paths: {
    "/v1/payments/transfer-batches": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: false }],
      },
    },
    "/v1/issuance/tokens/{tokenId}/freeze": {
      parameters: [{ name: "Idempotency-Key", in: "header", required: false }],
      post: {},
    },
    "/v1/issuance/tokens": {
      post: {},
    },
    "/v1/payments/transfers": {
      get: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: false }],
      },
    },
  },
};

test("derives idempotency-consuming POST paths from operation and path-item parameters", () => {
  assert.deepEqual(
    extractIdempotencyPostPaths(specWithOperationHeader),
    new Set(["/v1/payments/transfer-batches", "/v1/issuance/tokens/{tokenId}/freeze"])
  );
});

test("derives nothing from a document without paths", () => {
  assert.deepEqual(extractIdempotencyPostPaths({}), new Set());
  assert.deepEqual(extractIdempotencyPostPaths(null), new Set());
});

test("matches concrete example paths against OpenAPI templates", () => {
  assert.equal(
    examplePathMatchesTemplate(
      "/v1/issuance/tokens/tok_abc123/freeze",
      "/v1/issuance/tokens/{tokenId}/freeze"
    ),
    true
  );
  assert.equal(
    examplePathMatchesTemplate("/v1/payments/transfer-batches", "/v1/payments/transfer-batches"),
    true
  );
  assert.equal(
    examplePathMatchesTemplate(
      "/v1/issuance/tokens/freeze",
      "/v1/issuance/tokens/{tokenId}/freeze"
    ),
    false
  );
  assert.equal(
    examplePathMatchesTemplate(
      "/v1/issuance/tokens/tok_abc123/freeze/extra",
      "/v1/issuance/tokens/{tokenId}/freeze"
    ),
    false
  );
});

test("extracts fenced blocks with their opening line numbers", () => {
  const source = [
    "# Title",
    "",
    "```bash",
    "one",
    "```",
    "",
    "text",
    "```typescript",
    "two",
    "```",
    "",
  ].join("\n");
  assert.deepEqual(extractCodeBlocks(source), [
    { language: "bash", content: "one", line: 3 },
    { language: "typescript", content: "two", line: 8 },
  ]);
});

test("flags a curl POST example that omits the replay fence", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfer-batches"]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          '```bash title="Terminal"',
          "curl -X POST https://api.solana.com/v1/payments/transfer-batches \\",
          '  -H "Authorization: Bearer sk_test_..." \\',
          "  -d '{}'",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "introduction.mdx", line: 2, endpoint: "/v1/payments/transfer-batches" },
  ]);
});

test("accepts an example that shows the Idempotency-Key fence", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfer-batches"]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          '```bash title="Terminal"',
          "curl -X POST https://api.solana.com/v1/payments/transfer-batches \\",
          '  -H "Idempotency-Key: payroll-2026-05-14" \\',
          "  -d '{}'",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("ignores GET examples, non-POST blocks, and endpoints without the fence contract", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set([
      "/v1/payments/transfer-batches",
      "/v1/issuance/tokens/{tokenId}/freeze",
    ]),
    files: [
      {
        path: "send-payouts.mdx",
        source: [
          "```bash",
          "curl https://api.solana.com/v1/payments/transfer-batches/batch_1 \\",
          '  -H "Authorization: Bearer sk_test_..."',
          "```",
        ].join("\n"),
      },
      {
        path: "create-a-token.mdx",
        source: [
          "```bash",
          "curl -X POST https://api.solana.com/v1/issuance/tokens \\",
          '  -H "Authorization: Bearer sk_test_..." \\',
          "  -d '{}'",
          "```",
        ].join("\n"),
      },
      {
        path: "notes.mdx",
        source: ["```text", "POST /v1/payments/transfer-batches is fenced", "```"].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("flags fetch and requests.post examples in any language", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set([
      "/v1/issuance/tokens/{tokenId}/freeze",
      "/v1/payments/transfers",
    ]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          "```javascript",
          'await fetch("https://api.solana.com/v1/issuance/tokens/tok_abc123/freeze", {',
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
      {
        path: "memo.mdx",
        source: [
          "```python",
          "requests.post(",
          '    "https://api.solana.com/v1/payments/transfers",',
          "    json={'amount': '100.00'},",
          ")",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "introduction.mdx", line: 2, endpoint: "/v1/issuance/tokens/{tokenId}/freeze" },
    { file: "memo.mdx", line: 2, endpoint: "/v1/payments/transfers" },
  ]);
});

test("flags relative-path client.post examples without the replay fence", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/issuance/tokens/{tokenId}/unfreeze"]),
    files: [
      {
        path: "tutorial.mdx",
        source: [
          "```javascript",
          `await sdpAdmin.post(\`/v1/issuance/tokens/\${tokenId}/unfreeze\`, {`,
          "  signingCustodyWalletId,",
          "  accountAddress: destinationAddress,",
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "tutorial.mdx", line: 2, endpoint: "/v1/issuance/tokens/{tokenId}/unfreeze" },
  ]);
});
test("checks each request in a shared block separately", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set([
      "/v1/issuance/tokens/{tokenId}/pause",
      "/v1/issuance/tokens/{tokenId}/unpause",
    ]),
    files: [
      {
        path: "freeze-and-compliance.mdx",
        source: [
          "```bash",
          "# Pause",
          "curl -X POST https://api.solana.com/v1/issuance/tokens/tok_abc123/pause \\",
          '  -H "Authorization: Bearer sk_test_..." \\',
          '  -H "Idempotency-Key: pause-001" \\',
          "  -d '{}'",
          "",
          "# Unpause",
          "curl -X POST https://api.solana.com/v1/issuance/tokens/tok_abc123/unpause \\",
          '  -H "Authorization: Bearer sk_test_..." \\',
          "  -d '{}'",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    {
      file: "freeze-and-compliance.mdx",
      line: 8,
      endpoint: "/v1/issuance/tokens/{tokenId}/unpause",
    },
  ]);
});

test("splits multi-request blocks on comments, blank lines, and new statements", () => {
  const content = [
    "const first = await fetch(url, {",
    '  method: "POST",',
    "});",
    "",
    "// second",
    "await client.post(url2, {});",
  ].join("\n");
  assert.deepEqual(splitBlockIntoRequests(content), [
    { content: 'const first = await fetch(url, {\n  method: "POST",\n});', line: 0 },
    { content: "// second\nawait client.post(url2, {});", line: 4 },
  ]);
});

test("flags a fetch example that POSTs through a declared URL variable", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfer-batches"]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          "```typescript",
          'const url = "https://api.solana.com/v1/payments/transfer-batches";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "introduction.mdx", line: 4, endpoint: "/v1/payments/transfer-batches" },
  ]);
});

test("flags a client.post example that uses a declared relative-path variable", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/issuance/tokens/{tokenId}/unfreeze"]),
    files: [
      {
        path: "tutorial.mdx",
        source: [
          "```javascript",
          `const unfreezePath = \`/v1/issuance/tokens/\${tokenId}/unfreeze\`;`,
          "",
          "await sdpAdmin.post(unfreezePath, {",
          "  signingCustodyWalletId,",
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "tutorial.mdx", line: 4, endpoint: "/v1/issuance/tokens/{tokenId}/unfreeze" },
  ]);
});

test("tracks a URL declaration that a comment prefixes inside its chunk", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfer-batches"]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          "```typescript",
          "// Build the batch endpoint",
          'const url = "https://api.solana.com/v1/payments/transfer-batches";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "introduction.mdx", line: 5, endpoint: "/v1/payments/transfer-batches" },
  ]);
});

test("reassignment replaces a variable's stale target before the request is checked", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfers"]),
    files: [
      {
        path: "reassigned.mdx",
        source: [
          "```typescript",
          'let url = "https://api.solana.com/v1/payments/transfers";',
          "",
          'url = "https://api.solana.com/v1/payments/transfers/tr_123";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("checks a POST through a reassigned variable against its new endpoint", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set([
      "/v1/issuance/tokens/{tokenId}/freeze",
      "/v1/payments/transfers",
    ]),
    files: [
      {
        path: "reassigned.mdx",
        source: [
          "```typescript",
          'let url = "https://api.solana.com/v1/issuance/tokens/tok_abc123/freeze";',
          "",
          'url = "https://api.solana.com/v1/payments/transfers";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "reassigned.mdx", line: 6, endpoint: "/v1/payments/transfers" },
  ]);
});

test("checks a request against the target assigned before its call, not a later reassignment", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfer-batches"]),
    files: [
      {
        path: "introduction.mdx",
        source: [
          "```typescript",
          'const url = "https://api.solana.com/v1/payments/transfer-batches";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          'url = "https://api.solana.com/v1/issuance/tokens";',
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "introduction.mdx", line: 4, endpoint: "/v1/payments/transfer-batches" },
  ]);
});

test("reassignment before the call resolves to the new target without blank-line separators", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfers"]),
    files: [
      {
        path: "reassigned.mdx",
        source: [
          "```typescript",
          'let url = "https://api.solana.com/v1/payments/transfers";',
          'url = "https://api.solana.com/v1/payments/transfers/tr_123";',
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("a reassignment after the call does not flag the earlier safe request", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfers"]),
    files: [
      {
        path: "reassigned.mdx",
        source: [
          "```typescript",
          'const url = "https://api.solana.com/v1/issuance/tokens";',
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          'url = "https://api.solana.com/v1/payments/transfers";',
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("a live reassigned target is still flagged when the lines share one chunk", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfers"]),
    files: [
      {
        path: "reassigned.mdx",
        source: [
          "```typescript",
          'let url = "https://api.solana.com/v1/issuance/tokens";',
          'url = "https://api.solana.com/v1/payments/transfers";',
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { Authorization: "Bearer sk_test_..." },',
          "});",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, [
    { file: "reassigned.mdx", line: 4, endpoint: "/v1/payments/transfers" },
  ]);
});

test("accepts a variable-target POST that shows the fence and ignores variable-target GETs", () => {
  const violations = findMissingIdempotencyKeyExamples({
    idempotencyPostPaths: new Set(["/v1/payments/transfers"]),
    files: [
      {
        path: "fenced.mdx",
        source: [
          "```typescript",
          'const url = "https://api.solana.com/v1/payments/transfers";',
          "",
          "await fetch(url, {",
          '  method: "POST",',
          '  headers: { "Idempotency-Key": "payment-001" },',
          "});",
          "```",
        ].join("\n"),
      },
      {
        path: "listing.mdx",
        source: [
          "```typescript",
          'const url = "https://api.solana.com/v1/payments/transfers";',
          "",
          "const page = await fetch(url);",
          "```",
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});
