import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BYOK must cover exactly what organization-level RPC selection covers.
 *
 * `resolveRpcTarget` is the only resolver that reads
 * `organizations.settings.rpcProvider`, so every call site that honours an
 * organization's chosen provider must also receive the tenant connection
 * lookup. A new call site added without it would serve platform credentials to
 * an organization running on its own key, and nothing else would notice.
 *
 * Source-scanning rather than behavioural on purpose: the failure this guards
 * against is an omission at a call site, which no runtime test of existing
 * call sites can see.
 */
const apiSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function callSitesOf(name: string): Array<{ file: string; passesLookup: boolean }> {
  const files = readdirSync(apiSrc, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.includes(".test."))
    .map((entry) => path.join(apiSrc, entry));

  const sites: Array<{ file: string; passesLookup: boolean }> = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let index = source.indexOf(`${name}({`);
    while (index !== -1) {
      // The call's argument object ends at the first line that closes it.
      const tail = source.slice(index, index + 800);
      const end = tail.indexOf("});");
      const body = end === -1 ? tail : tail.slice(0, end);
      sites.push({
        file: path.relative(apiSrc, file),
        passesLookup: body.includes("connections:"),
      });
      index = source.indexOf(`${name}({`, index + 1);
    }
  }
  return sites;
}

describe("BYOK parity with organization RPC selection", () => {
  it("passes the tenant lookup at every resolveRpcTarget call site", () => {
    const sites = callSitesOf("resolveRpcTarget");

    expect(sites.length).toBeGreaterThan(0);
    const missing = sites.filter((site) => !site.passesLookup).map((site) => site.file);
    expect(missing).toEqual([]);
  });

  it("covers the relay, the connectivity test and the signer check", () => {
    const files = new Set(callSitesOf("resolveRpcTarget").map((site) => site.file));

    expect(files).toContain("routes/rpc/handlers.ts");
    expect(files).toContain("routes/custody/handlers/signer-check.ts");
  });
});
