import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types/site";

// Each test file runs in its own process. Set these before importing the site
// module so browser links use the configured deployment URL on every branch.
const DEPLOYMENT_DOCS = "https://docs.stage.example/docs";
const DEPLOYMENT_API = "https://api.stage.example";
process.env.NEXT_PUBLIC_SDP_DOCS_URL = DEPLOYMENT_DOCS;
process.env.NEXT_PUBLIC_SDP_API_URL = DEPLOYMENT_API;
process.env.VERCEL_ENV = "preview";
process.env.VERCEL_GIT_COMMIT_REF = "earn-docs";
process.env.VERCEL_URL = "branch-preview.vercel.app";

describe("deployment docs URLs", () => {
  it("keeps configured browser URLs on every branch", async () => {
    const site = await import("@/lib/site");
    assert.equal(site.docsUrl, DEPLOYMENT_DOCS);
    assert.equal(site.apiUrl, DEPLOYMENT_API);
    assert.equal(site.getDocsPageUrl("earn"), `${DEPLOYMENT_DOCS}/earn`);
    assert.equal(site.getDocsMarkdownUrl("earn"), `${DEPLOYMENT_DOCS}/earn.md`);
  });

  it("keeps generated discovery URLs canonical", async () => {
    const { canonicalSite } = await import("@/lib/site");
    assert.equal(canonicalSite.docsUrl, DEFAULT_SDP_DOCS_URL);
    assert.equal(canonicalSite.apiUrl, DEFAULT_SDP_API_URL);
    assert.equal(canonicalSite.apiOpenApiUrl, `${DEFAULT_SDP_API_URL}/openapi.json`);
    assert.equal(canonicalSite.getDocsPageUrl("earn"), `${DEFAULT_SDP_DOCS_URL}/earn`);
  });
});
