import { beforeEach, describe, expect, it } from "vitest";
import { tokenLifecycle } from "@/app/dashboard/issuance/issuance-token-state.redesign";
import {
  fetchIssuanceTokenFacets,
  fetchIssuanceTokensPage,
} from "@/app/dashboard/issuance/issuance-tokens.data";
import { buildWorld, demoPathParts } from "./demo-fixtures";
import { demoWrite } from "./demo-handlers";
import type { DemoOp } from "./demo-ops";
import { applyDemoOps } from "./demo-replay";
import { decodeDemoOps, encodeDemoOps } from "./demo-session";
import { DEMO_DEPLOY_FAILURE, DEMO_DEPLOY_MS, holderAddress } from "./issuance-fixtures";
import { issuanceRead } from "./issuance-reads";

/*
 * The Issuance demo end to end: its reads answer the screens' own data helpers, and every
 * operation walks from draft to deploy to the live token's supply, freezes, pauses, authorities
 * and control list, refusing what the SDP API refuses. The session is a plain log here, carried
 * from write to write as the browser's cookies would carry it.
 */

const NOW = new Date("2026-10-03T12:00:00.000Z");
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TREASURY = "demo_cwlt_treasury";

let ops: DemoOp[] = [];
let now = NOW;

function world() {
  return applyDemoOps(buildWorld(now), ops, now);
}

// biome-ignore lint/suspicious/noExplicitAny: tests read loosely shaped API envelopes.
type Answer = { status: number; body: any };

function read(path: string): Answer {
  const parts = demoPathParts(path);
  if (parts?.segments[0] !== "issuance") throw new Error(`not an issuance path: ${path}`);
  const answer = issuanceRead(world().issuance, parts.segments.slice(1), parts.params);
  if (!answer) throw new Error(`no demo answer for ${path}`);
  return answer as Answer;
}

function write(method: string, path: string, body: unknown = {}): Answer {
  const parts = demoPathParts(path);
  if (!parts) throw new Error(`not a demo path: ${path}`);
  const result = demoWrite(method, { segments: parts.segments, body, world: world(), ops, now });
  if (!result) throw new Error(`no demo stand-in for ${method} ${path}`);
  ops = [...ops, ...result.ops];
  return result.answer(world()) as Answer;
}

/** The API client the screens' data helpers call, answered by the demo. */
async function request(path: string): Promise<Response> {
  const { status, body } = read(path);
  return Response.json(body, { status });
}

function refusal(answer: Answer) {
  return [answer.status, answer.body?.error?.code];
}

function token(id: string) {
  return read(`/v1/issuance/tokens/${id}`).body.data.token;
}

function latestDeploy(id: string) {
  return read(`/v1/issuance/tokens/${id}/transactions?type=deploy&page=1&pageSize=5`).body.data[0];
}

function lifecycle(id: string) {
  return tokenLifecycle(token(id), latestDeploy(id)?.status ?? null);
}

beforeEach(() => {
  ops = [];
  now = NOW;
});

describe("the token list", () => {
  it("shows a token in every state, newest first, through the list's own helper", async () => {
    const page = await fetchIssuanceTokensPage(request, {
      search: "",
      status: "all",
      template: "all",
      date: "all",
      sort: "newest",
      page: 1,
      pageSize: 24,
    } as never);
    expect(page.error).toBeNull();
    expect(page.total).toBe(7);
    expect(page.tokens[0]?.symbol).toBe("HDR");
    expect(
      ["demo_tok_hdr", "demo_tok_usdp", "demo_tok_acme", "demo_tok_vusd", "demo_tok_mrdn"].map(
        lifecycle
      )
    ).toEqual(["draft", "failed", "draft", "live", "paused"]);
  });

  it("filters, searches and sorts as the API does", () => {
    const symbols = (path: string) =>
      read(path).body.data.map((row: { symbol: string }) => row.symbol);
    expect(symbols("/v1/issuance/tokens?deploymentStatus=draft")).toEqual(["HDR", "ACME", "USDP"]);
    expect(symbols("/v1/issuance/tokens?deploymentStatus=paused")).toEqual(["MRDN"]);
    expect(symbols("/v1/issuance/tokens?search=usd")).toEqual(["VUSD", "USDP"]);
    expect(symbols("/v1/issuance/tokens?sortBy=name&sortDirection=asc")[0]).toBe("ACME");
    expect(read("/v1/issuance/tokens?pageSize=2").body.meta).toMatchObject({
      total: 7,
      page: 1,
      pageSize: 2,
      hasMore: true,
    });
  });

  it("counts the project's tokens for the filters", async () => {
    const facets = await fetchIssuanceTokenFacets(request);
    expect(facets.total).toBe(7);
    expect(facets.deploymentStatuses).toEqual({ draft: 3, active: 3, paused: 1 });
    expect(facets.templates).toEqual([
      { template: "custom", count: 3 },
      { template: "stablecoin", count: 4 },
    ]);
  });
});

describe("one token", () => {
  it("answers the token, its profile and the authorities it is asked for", () => {
    const detail = read(
      "/v1/issuance/tokens/demo_tok_vusd?includeAllowlistAuthority=true&includePauseAuthority=true"
    ).body.data;
    expect(detail.token.totalSupply).toBe("250000");
    expect(detail.allowlistAuthority).toBe(detail.token.mintAuthority);
    expect(detail.pauseAuthority).toBe(detail.token.mintAuthority);
    expect(
      read("/v1/issuance/asset-profiles/by-token/demo_tok_vusd").body.data.assetProfile
    ).toMatchObject({ assetCategory: "stablecoin", assetType: "fiat_backed" });
    expect(read("/v1/issuance/tokens/demo_tok_nope").status).toBe(404);
    expect(read("/v1/issuance/tokens/demo_tok_vusd?includeFreezeAuthority=yes").status).toBe(400);
  });

  it("lists its history, blocklist and frozen accounts", () => {
    const types = read("/v1/issuance/tokens/demo_tok_vusd/transactions").body.data.map(
      (row: { type: string }) => row.type
    );
    expect(types.at(-1)).toBe("deploy");
    expect(types).toEqual(expect.arrayContaining(["mint", "burn", "freeze"]));
    expect(read("/v1/issuance/tokens/demo_tok_vusd/allowlist").body.meta.total).toBe(2);
    expect(read("/v1/issuance/tokens/demo_tok_vusd/frozen?page=1&pageSize=1").body.meta.total).toBe(
      1
    );
    const audit = read("/v1/issuance/tokens/demo_tok_vusd/audit?action=mint").body.data;
    expect(audit.every((row: { action: string }) => row.action === "mint")).toBe(true);
    expect(audit[0]).toMatchObject({ actorType: "user", status: "success" });
  });

  it("says why the failed deploy failed", () => {
    expect(latestDeploy("demo_tok_usdp")).toMatchObject({
      status: "failed",
      error: DEMO_DEPLOY_FAILURE,
    });
  });
});

describe("a draft to a live token", () => {
  it("creates, deploys, and shows it deploying until it lands", () => {
    const created = write("POST", "/v1/issuance/asset-profiles", {
      name: "Harbor Dollar",
      symbol: "HUSD",
      decimals: 6,
      template: "stablecoin",
      requiresAllowlist: false,
      isMintable: true,
      isFreezable: true,
      assetCategory: "stablecoin",
      assetType: "generic",
      maxSupply: "1000",
      signingCustodyWalletId: TREASURY,
      issuanceMetadata: {
        asset: { name: "Harbor Dollar", pegCurrency: "USD" },
        compliance: { accessControl: "blocklist" },
        custom: { customer: { authorityWalletIds: { "mint-authority": TREASURY } } },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.token.id as string;
    expect(created.body.data.assetProfile.tokenId).toBe(id);
    expect(lifecycle(id)).toBe("draft");
    expect(read("/v1/issuance/tokens?deploymentStatus=draft").body.meta.total).toBe(4);

    expect(
      write("POST", `/v1/issuance/tokens/${id}/deploy`, {
        signingCustodyWalletId: TREASURY,
        feePayment: "sponsored",
      }).status
    ).toBe(200);
    expect(lifecycle(id)).toBe("deploying");
    expect(refusal(write("POST", `/v1/issuance/tokens/${id}/deploy`, {}))).toEqual([
      409,
      "CONFLICT",
    ]);

    now = new Date(NOW.getTime() + DEMO_DEPLOY_MS);
    expect(lifecycle(id)).toBe("live");
    expect(token(id)).toMatchObject({ status: "active", ablListAddress: expect.any(String) });
    expect(read(`/v1/issuance/tokens/${id}/audit?action=deploy`).body.data).toHaveLength(1);

    const minted = write("POST", `/v1/issuance/tokens/${id}/mint`, {
      signingCustodyWalletId: TREASURY,
      mint: { destination: ADDRESS, amount: "600" },
    });
    expect(minted.body.data.transaction).toMatchObject({ type: "mint", status: "finalized" });
    expect(minted.body.data.tokenAccount).toBe(ADDRESS);
    expect(token(id).totalSupply).toBe("600");
    expect(
      refusal(
        write("POST", `/v1/issuance/tokens/${id}/mint`, {
          mint: { destination: ADDRESS, amount: "401" },
        })
      )
    ).toEqual([400, "MAX_SUPPLY_EXCEEDED"]);
  });

  it("retries the failed deploy and lands it", () => {
    write("POST", "/v1/issuance/tokens/demo_tok_usdp/deploy", { feePayment: "sponsored" });
    now = new Date(NOW.getTime() + DEMO_DEPLOY_MS + 1);
    expect(lifecycle("demo_tok_usdp")).toBe("live");
  });

  it("refuses an operation before the token is live", () => {
    expect(
      refusal(
        write("POST", "/v1/issuance/tokens/demo_tok_acme/mint", {
          mint: { destination: ADDRESS, amount: "1" },
        })
      )
    ).toEqual([400, "TOKEN_NOT_DEPLOYED"]);
    expect(ops).toEqual([]);
  });
});

describe("a live token's operations", () => {
  const VUSD = "/v1/issuance/tokens/demo_tok_vusd";

  it("burns, seizes and force-burns only what the source holds", () => {
    // The issuer's treasury signs and holds the seeded supply; ADDRESS holds none of it.
    const treasury = token("demo_tok_vusd").mintAuthority as string;
    expect(
      refusal(write("POST", `${VUSD}/burn`, { burn: { source: treasury, amount: "1" } }))[0]
    ).toBe(400);
    expect(
      refusal(
        write("POST", `${VUSD}/burn`, {
          signingCustodyWalletId: TREASURY,
          burn: { source: ADDRESS, amount: "1" },
        })
      )[0]
    ).toBe(400);
    write("POST", `${VUSD}/burn`, {
      signingCustodyWalletId: TREASURY,
      burn: { source: treasury, amount: "50000" },
    });
    expect(token("demo_tok_vusd").totalSupply).toBe("200000");
    write("POST", `${VUSD}/seize`, {
      seize: { source: treasury, destination: ADDRESS, amount: "10" },
    });
    expect(token("demo_tok_vusd").totalSupply).toBe("200000");
    write("POST", `${VUSD}/force-burn`, { forceBurn: { source: ADDRESS, amount: "0.5" } });
    expect(token("demo_tok_vusd").totalSupply).toBe("199999.5");
    expect(
      refusal(
        write("POST", `${VUSD}/force-burn`, { forceBurn: { source: ADDRESS, amount: "20" } })
      )[0]
    ).toBe(400);
    expect(
      refusal(
        write("POST", `${VUSD}/burn`, {
          signingCustodyWalletId: TREASURY,
          burn: { source: treasury, amount: "999999999" },
        })
      )[0]
    ).toBe(400);
  });

  it("keeps a given-up metadata authority given up", () => {
    write("POST", `${VUSD}/authority`, { authority: { role: "metadata", newAuthority: null } });
    const detail = read(`${VUSD}?includeMetadataAuthority=true`).body.data;
    expect(detail.metadataAuthority).toBeNull();
    expect(
      write("POST", `${VUSD}/authority`, { authority: { role: "metadata", newAuthority: ADDRESS } })
        .status
    ).toBe(400);
  });

  it("won't mint to a blocklisted address", () => {
    expect(
      refusal(
        write("POST", `${VUSD}/mint`, {
          mint: { destination: holderAddress("vusd", 7), amount: "1" },
        })
      )
    ).toEqual([403, "ON_TOKEN_BLOCKLIST"]);
  });

  it("freezes and unfreezes an account", () => {
    const frozen = write("POST", `${VUSD}/freeze`, { accountAddress: ADDRESS, reason: "Review" });
    expect(frozen.status).toBe(201);
    expect(frozen.body.data.frozenAccount).toMatchObject({ accountAddress: ADDRESS });
    expect(read(`${VUSD}/frozen`).body.meta.total).toBe(2);
    expect(refusal(write("POST", `${VUSD}/freeze`, { accountAddress: ADDRESS }))).toEqual([
      409,
      "CONFLICT",
    ]);
    expect(write("POST", `${VUSD}/unfreeze`, { accountAddress: ADDRESS }).status).toBe(200);
    expect(read(`${VUSD}/frozen`).body.meta.total).toBe(1);
  });

  it("pauses and resumes transfers", () => {
    write("POST", `${VUSD}/pause`, {});
    expect(lifecycle("demo_tok_vusd")).toBe("paused");
    expect(write("POST", `${VUSD}/pause`, {}).status).toBe(400);
    write("POST", "/v1/issuance/tokens/demo_tok_mrdn/unpause", {});
    expect(lifecycle("demo_tok_mrdn")).toBe("live");
    expect(write("POST", "/v1/issuance/tokens/demo_tok_star/pause", {}).status).toBe(400);
  });

  it("moves an authority, and locks the supply when the mint authority is given up", () => {
    write("POST", `${VUSD}/authority`, {
      authority: { role: "freeze", newAuthority: ADDRESS },
    });
    expect(token("demo_tok_vusd").freezeAuthority).toBe(ADDRESS);
    write("POST", `${VUSD}/authority`, { authority: { role: "mint", newAuthority: null } });
    expect(token("demo_tok_vusd").mintAuthority).toBeNull();
    expect(
      write("POST", `${VUSD}/mint`, { mint: { destination: ADDRESS, amount: "1" } }).status
    ).toBe(400);
    expect(write("PATCH", VUSD, { maxSupply: "9000000" }).status).toBe(400);
  });

  it("adds to and removes from the control list", () => {
    const added = write("POST", "/v1/issuance/tokens/demo_tok_mrdn/allowlist", {
      address: ADDRESS,
      label: "New investor",
    });
    expect(added.status).toBe(201);
    expect(added.body.data.entry).toMatchObject({ address: ADDRESS, status: "active" });
    expect(
      refusal(write("POST", "/v1/issuance/tokens/demo_tok_mrdn/allowlist", { address: ADDRESS }))
    ).toEqual([409, "CONFLICT"]);
    expect(read("/v1/issuance/tokens/demo_tok_mrdn/allowlist").body.meta.total).toBe(4);
    const entryId = added.body.data.entry.id as string;
    expect(write("DELETE", `/v1/issuance/tokens/demo_tok_mrdn/allowlist/${entryId}`).status).toBe(
      204
    );
    expect(read("/v1/issuance/tokens/demo_tok_mrdn/allowlist").body.meta.total).toBe(3);
  });

  it("adds a mint's destination to an allowlist token's list", () => {
    write("POST", "/v1/issuance/tokens/demo_tok_mrdn/unpause", {});
    write("POST", "/v1/issuance/tokens/demo_tok_mrdn/mint", {
      mint: { destination: ADDRESS, amount: "10" },
    });
    expect(read("/v1/issuance/tokens/demo_tok_mrdn/allowlist").body.meta.total).toBe(4);
  });
});

describe("edits", () => {
  it("saves a token's fields and its profile, as the Details tab does", () => {
    const profile = read("/v1/issuance/asset-profiles/by-token/demo_tok_acme").body.data
      .assetProfile;
    expect(
      write("PATCH", "/v1/issuance/tokens/demo_tok_acme", {
        name: "Acme Rewards",
        symbol: "ACMR",
        maxSupply: "1000000",
      }).body.data.token
    ).toMatchObject({ name: "Acme Rewards", symbol: "ACMR", maxSupply: "1000000" });
    const updated = write("PATCH", `/v1/issuance/asset-profiles/${profile.id}`, {
      issuanceMetadata: {
        ...profile.issuanceMetadata,
        asset: { ...profile.issuanceMetadata.asset, website: "https://acme.example.com" },
        visibility: { public: ["asset.name", "asset.website"] },
      },
    }).body.data.assetProfile;
    expect(updated.publicMetadata).toEqual({
      asset: { name: "Acme Points", website: "https://acme.example.com" },
    });
    expect(read("/v1/issuance/tokens/demo_tok_acme/audit?action=update").body.data).toHaveLength(1);
  });

  it("keeps the symbol fixed once the token is live", () => {
    expect(write("PATCH", "/v1/issuance/tokens/demo_tok_vusd", { symbol: "XUSD" }).status).toBe(
      400
    );
  });
});

describe("the session", () => {
  it("survives the cookie's JSON round trip", () => {
    write("POST", "/v1/issuance/asset-profiles", {
      name: "Round Trip",
      symbol: "RT",
      assetCategory: "generic",
      assetType: "generic",
      issuanceMetadata: { asset: { name: "Round Trip" } },
    });
    write("POST", "/v1/issuance/tokens/demo_tok_vusd/pause", {});
    expect(decodeDemoOps(encodeDemoOps(ops))).toEqual(ops);
  });
});
