import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SDP_AI_GUIDE_URL, SDP_AI_GUIDE_DOCS_SLUG } from "@sdp/types/site";
import { canonicalSite } from "@/lib/site";

// api.solana.com/llms.txt links the shared constant, and check:links only reads
// MDX, so a renamed page would leave that link dead without this check.
describe("AI guide URL", () => {
  it("names a docs page", () => {
    const contentDir = path.resolve(import.meta.dirname, "../content/docs");
    assert.ok(
      existsSync(path.join(contentDir, `${SDP_AI_GUIDE_DOCS_SLUG}.mdx`)),
      `content/docs/${SDP_AI_GUIDE_DOCS_SLUG}.mdx does not exist`
    );
  });

  it("is the page the docs llms files link", () => {
    assert.equal(canonicalSite.aiGuideUrl, DEFAULT_SDP_AI_GUIDE_URL);
  });
});
