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
});
