import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDashboardUrl } from "@/lib/dashboard-url";

test("docs link to the matching dashboard deployment", () => {
  const preview: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SDP_WEB_URL: "https://platform.solana.com/dashboard",
    VERCEL_RELATED_PROJECTS: JSON.stringify([
      {
        project: { name: "sdp-web" },
        preview: { branch: "sdp-web-git-branch.vercel.app" },
        production: { alias: "platform.solana.com" },
      },
    ]),
  };
  assert.equal(resolveDashboardUrl(preview), "https://sdp-web-git-branch.vercel.app/");
  assert.equal(resolveDashboardUrl({ ...preview, VERCEL_RELATED_PROJECTS: undefined }), null);
  assert.equal(resolveDashboardUrl({ NODE_ENV: "production" }), "https://platform.solana.com/");
  assert.equal(resolveDashboardUrl({ NODE_ENV: "development" }), "http://localhost:3000/");
  assert.throws(
    () => resolveDashboardUrl({ NODE_ENV: "production", NEXT_PUBLIC_SDP_WEB_URL: "not-a-url" }),
    /NEXT_PUBLIC_SDP_WEB_URL must be an absolute HTTP URL/
  );
  assert.throws(
    () =>
      resolveDashboardUrl({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        VERCEL_RELATED_PROJECTS: "invalid",
      }),
    /VERCEL_RELATED_PROJECTS must be valid JSON/
  );
});
