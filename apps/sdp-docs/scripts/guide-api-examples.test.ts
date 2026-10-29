import assert from "node:assert/strict";
import { describe, it } from "node:test";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks } from "@/lib/docs-blocks";
import { type PublicSurface, publicSurface } from "@/lib/release-channel";

describe("guide API examples", () => {
  it("gives the browser and Markdown the same catalog request, including its replay key", () => {
    const source = '<ApiExample operation="create-wallet" />\n';
    const markdown = expandDocsBlocks(source, "content/docs/guides/setup-wallets.mdx");
    assert.match(markdown, /curl -X POST 'https:\/\/api\.solana\.com\/v1\/wallets'/);
    assert.match(markdown, /Authorization: Bearer \$SDP_API_KEY/);
    assert.match(markdown, /Idempotency-Key: \$\(uuidgen\)/);
    assert.doesNotMatch(markdown, /sf_\.\.\./);

    const processor = unified().use(remarkParse).use(remarkMdx).use(remarkDocsBlocks);
    const tree = processor.parse(source);
    processor.runSync(tree, { path: "content/docs/guides/setup-wallets.mdx", value: source });
    const [code] = tree.children;
    assert.equal(code?.type, "code");
    if (code?.type !== "code") return;
    const [expected] = processor.parse(markdown).children;
    assert.equal(expected?.type, "code");
    if (expected?.type !== "code") return;
    assert.equal(code.value, expected.value);
  });

  it("uses the shared TypeScript snippet when requested", () => {
    const markdown = expandDocsBlocks(
      '<ApiExample operation="create-wallet" language="ts" />\n',
      "content/docs/introduction.mdx"
    );
    assert.match(markdown, /^```typescript\n/);
    assert.match(markdown, /crypto\.randomUUID\(\)/);
    assert.match(markdown, /process\.env\.SDP_API_KEY/);
  });

  it("shows a pause request that executes with a replay key", () => {
    const markdown = expandDocsBlocks(
      '<ApiExample operation="pause-token" />\n',
      "content/docs/tokens/freeze-and-compliance.mdx"
    );
    assert.match(markdown, /Idempotency-Key: \$\(uuidgen\)/);
    assert.match(markdown, /signingCustodyWalletId/);
    assert.doesNotMatch(markdown, /simulate|priorityFee/);
  });

  it("rejects an operation absent from the public reference", () => {
    assert.throws(
      () => expandDocsBlocks('<ApiExample operation="missing" />\n', "guide.mdx"),
      /missing is not in this channel's public API/
    );
  });

  it("omits examples on a page the release channel does not publish", () => {
    const stable: PublicSurface = {
      ...publicSurface,
      releaseChannel: "stable",
      modules: ["custody", "payments", "recurring_payments"],
    };
    const source = '---\nmodule: issuance\n---\n\n<ApiExample operation="get-token" />\n';
    const examples = { releaseChannel: "stable", operations: {} };
    assert.doesNotMatch(
      expandDocsBlocks(source, "content/docs/tokens/manage-token-settings.mdx", {
        surface: stable,
        examples,
      }),
      /ApiExample|curl/
    );
    assert.throws(
      () =>
        expandDocsBlocks(
          '<ApiExample operation="get-token" />\n',
          "content/docs/introduction.mdx",
          {
            surface: stable,
            examples,
          }
        ),
      /get-token is not in this channel's public API/
    );
  });
});
