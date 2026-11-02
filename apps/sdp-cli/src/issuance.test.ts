import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSET_CATEGORIES, ASSET_TYPES } from "@sdp/types/asset-profiles";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Command } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { issuanceCommands } from "./issuance-commands";
import { runCli } from "./run";

const meta = { requestId: "req_issuance", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "issuance-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "issuance-key", SDP_API_URL: session.SDP_API_URL };
const amount = "9007199254740993.000001";
const token = {
  id: "tok_example",
  projectId: session.SDP_PROJECT_ID,
  organizationId: "org_example",
  signingCustodyWalletId: "cwlt_example",
  mintAddress: null,
  mintAuthority: null,
  freezeAuthority: null,
  ablListAddress: null,
  name: "Fixture token",
  symbol: "FIX",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "custom",
  extensions: null,
  totalSupply: "0",
  totalSupplyUpdatedAt: null,
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  status: "pending",
  deployedAt: null,
  createdBy: "key_example",
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const issuanceMetadata = {
  asset: { name: "Fixture asset", issuerName: "Fixture issuer" },
  custom: { customer: { internalDesk: "private_fixture" } },
  visibility: { public: [] },
};
const profile = {
  id: "profile_example",
  organizationId: token.organizationId,
  projectId: token.projectId,
  tokenId: token.id,
  assetCategory: "generic",
  assetType: "generic",
  assetTypeVersion: 1,
  issuanceMetadata,
  publicMetadata: {},
  status: "active",
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const mintTerms = { destination: SOL_MINT, amount, memo: "00042" };
const burnTerms = { source: SOL_MINT, amount };
const seizeTerms = { ...burnTerms, destination: SOL_MINT, delegateAuthority: SOL_MINT };
const authorityTerms = { role: "mint", newAuthority: null };
const transaction = {
  id: "ttx_example",
  tokenId: token.id,
  organizationId: token.organizationId,
  type: "mint",
  status: "processing",
  signature: null,
  serializedTx: null,
  params: { mint: mintTerms },
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  initiatedByKeyId: "key_example",
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const preparedTransaction = {
  serialized: "AQIDBA==",
  blockhash: "blockhash_fixture",
  lastValidBlockHeight: "9007199254740993",
};
const create = { name: token.name, symbol: token.symbol };
const bodySamples: Record<string, JsonObject> = {
  createToken: create,
  createTokenWithAssetProfile: {
    ...create,
    assetCategory: "generic",
    assetType: "generic",
    issuanceMetadata,
  },
  updateToken: { description: null },
  updateAssetProfile: { issuanceMetadata },
  deployToken: {},
  prepareDeployToken: { signingWalletId: "provider_wallet" },
  prepareDeployMetadata: {},
  confirmDeploy: { signature: "1".repeat(64), mint: SOL_MINT },
  executeMint: { mint: mintTerms },
  prepareMint: { mint: mintTerms },
  executeBurn: { signingCustodyWalletId: "cwlt_example", burn: burnTerms },
  prepareBurn: { signingCustodyWalletId: "cwlt_example", burn: burnTerms },
  executeSeize: { seize: seizeTerms },
  prepareSeize: { seize: seizeTerms },
  executeForceBurn: { forceBurn: burnTerms },
  prepareForceBurn: { forceBurn: burnTerms },
  executeUpdateAuthority: { authority: authorityTerms },
  prepareUpdateAuthority: { authority: authorityTerms },
  pauseToken: {},
  unpauseToken: {},
  freezeAccount: { accountAddress: SOL_MINT },
  unfreezeAccount: { accountAddress: SOL_MINT },
  addTokenAllowlistEntry: { address: SOL_MINT },
  enrollHolder: { walletAddress: SOL_MINT, reviewMode: "manual" },
};
const pathValues: Record<string, string> = {
  tokenId: token.id,
  templateId: "custom",
  entryId: "entry/example",
  profileId: profile.id,
};
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  response: Response,
  options: { env?: NodeJS.ProcessEnv; stdin?: string; failure?: Error } = {}
) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? apiKey,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      if (options.failure) throw options.failure;
      return response;
    },
    readStdin: async () => options.stdin ?? "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}
function response(data: JsonObject, status = 200) {
  return Response.json({ data, meta }, { status });
}
function paginated(data: JsonObject[]) {
  return Response.json({
    data,
    meta: { total: data.length, page: 1, pageSize: 50, hasMore: false, requestId: meta.requestId },
  });
}
function error(status = 403, code = "FORBIDDEN") {
  return Response.json(
    { error: { code, message: "Issuance operation refused" }, meta },
    { status }
  );
}
function body(record: RecordedRequest) {
  return JSON.parse(String(record.init.body));
}
function argsFor(command: Command) {
  const op = operationById(command.operationId),
    args = [...command.words];
  for (const parameter of op.parameters) {
    if (parameter.location === "path") {
      assert(pathValues[parameter.name]);
      args.push(pathValues[parameter.name]);
    }
    if (parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key")
      args.push("--idempotency-key", "intent-42");
  }
  if (op.body !== null) {
    assert(bodySamples[command.operationId], command.operationId);
    args.push("--data", JSON.stringify(bodySamples[command.operationId]));
  }
  return args;
}

test("all 44 issuance and asset-profile commands provide offline help", async () => {
  assert.equal(issuanceCommands.length, 44);
  for (const args of [
    ["issuance"],
    ["asset-profiles"],
    ...issuanceCommands.map((command) => [...command.words, "--help"]),
  ]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  const publicHelp = await invoke(["issuance", "tokens", "metadata", "get", "--help"], error(), {
    env: {},
  });
  assert(publicHelp.stdout.includes("Public endpoint"));
  assert(!publicHelp.stdout.includes("Requires action:"));
});

test("every operation is connected to the generated method, path, and body", async () => {
  for (const command of issuanceCommands) {
    const op = operationById(command.operationId),
      result = await invoke(argsFor(command), error());
    assert.equal(result.code, 1, `${command.operationId}: ${result.stderr}`);
    assert.equal(result.requests.length, 1);
    const record = result.requests[0];
    assert.equal(record.init.method, op.method);
    let pathname = op.path;
    for (const parameter of op.parameters.filter((p) => p.location === "path"))
      pathname = pathname.replace(
        `{${parameter.name}}`,
        encodeURIComponent(pathValues[parameter.name])
      );
    assert.equal(new URL(record.url).pathname, pathname);
    if (op.body === null) assert.equal(record.init.body, undefined);
    else assert.deepEqual(body(record), bodySamples[command.operationId]);
    assert.equal(
      new Headers(record.init.headers).get("authorization"),
      op.authorization.kind === "public" ? null : "Bearer issuance-key"
    );
  }
});

test("authenticated operations require a project for sessions and preserve specialized grants", async () => {
  for (const command of issuanceCommands) {
    if (operationById(command.operationId).authorization.kind === "public") continue;
    const result = await invoke(argsFor(command), error(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, `${command.operationId}: ${result.stderr}`);
    assert(result.stderr.includes("--project"));
    assert.equal(result.requests.length, 0);
  }
  for (const [id, action] of [
    ["createToken", "issuance.manage"],
    ["executeMint", "issuance.execute"],
    ["executeSeize", "issuance.enforce"],
    ["executeUpdateAuthority", "issuance.authority"],
    ["refreshTokenSupply", "issuance.read"],
    ["updateAssetProfile", "issuance.manage"],
  ])
    assert.deepEqual(operationById(id).authorization, { kind: "action", action });
});

test("public metadata uses no credential or tenant even with conflicting invalid account settings", async () => {
  const metadata = {
    name: token.name,
    symbol: token.symbol,
    image: "https://example.test/token.png",
    asset: { name: "Public name" },
    chain: { decimals: 6 },
  };
  for (const env of [
    {},
    {
      SDP_API_KEY: "invalid key",
      SDP_TOKEN: "also invalid",
      SDP_PROJECT_ID: " ",
      SDP_ORGANIZATION_ID: " ",
    },
  ]) {
    const result = await invoke(
      [
        "issuance",
        "tokens",
        "metadata",
        "get",
        "token/with?#",
        "--api-key",
        "ignored",
        "--token",
        "also-ignored",
        "--project",
        "ignored",
      ],
      Response.json(metadata),
      { env }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), metadata);
    assert.equal(result.requests.length, 1);
    const headers = new Headers(result.requests[0].init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-project-id"), null);
    assert.equal(headers.get("content-type"), null);
    assert.equal(
      new URL(result.requests[0].url).pathname,
      "/v1/issuance/tokens/token%2Fwith%3F%23/metadata.json"
    );
  }
  const missing = await invoke(
    ["issuance", "tokens", "metadata", "get", token.id],
    Response.json({ error: { code: "NOT_FOUND", message: "Token not found" } }, { status: 404 }),
    { env: {} }
  );
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, "NOT_FOUND");
});

test("draft creation preserves explicit zero decimals, false capabilities and extension overrides", async () => {
  const overrides = {
    extensions: { nonTransferable: false, scaledUiAmount: false },
    requiresAllowlist: false,
  };
  const result = await invoke(
    [
      "issuance",
      "tokens",
      "create",
      "--name",
      token.name,
      "--symbol",
      token.symbol,
      "--decimals",
      "0",
      "--requires-allowlist",
      "false",
      "--mintable",
      "false",
      "--freezable",
      "false",
      "--max-supply",
      amount,
      "--overrides",
      JSON.stringify(overrides),
    ],
    response({ token }, 201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    ...create,
    decimals: 0,
    requiresAllowlist: false,
    isMintable: false,
    isFreezable: false,
    maxSupply: amount,
    overrides,
  });
  assert.deepEqual(JSON.parse(result.stdout).data.token, token);
  assert.equal(result.requests.length, 1);
});

test("asset-profile creation preserves private metadata and returns both records without another write", async () => {
  const payload = bodySamples.createTokenWithAssetProfile;
  const result = await invoke(
    ["issuance", "tokens", "create-with-asset-profile", "--data", JSON.stringify(payload)],
    response({ token, assetProfile: profile }, 201),
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), payload);
  assert.deepEqual(JSON.parse(result.stdout).data, { token, assetProfile: profile });
  assert.equal(
    new Headers(result.requests[0].init.headers).get("x-project-id"),
    session.SDP_PROJECT_ID
  );
  assert.equal(result.requests.length, 1);
});

test("token and profile updates support complete JSON through inline, file and stdin without merging defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-issuance-input-"));
  try {
    const input = JSON.stringify({ description: null, uri: null, imageUrl: null, maxSupply: null }),
      filename = path.join(directory, "update.json");
    await writeFile(filename, input);
    for (const source of [input, `@${filename}`, "-"]) {
      const result = await invoke(
        ["issuance", "tokens", "update", token.id, "--data", source],
        response({ token }),
        { stdin: input }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), JSON.parse(input));
    }
    const updated = await invoke(
      [
        "asset-profiles",
        "update",
        profile.id,
        "--issuance-metadata",
        JSON.stringify(issuanceMetadata),
      ],
      response({ assetProfile: profile })
    );
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(body(updated.requests[0]), { issuanceMetadata });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token list filters are server-side and paginated envelopes remain unchanged", async () => {
  const result = await invoke(
    [
      "issuance",
      "tokens",
      "list",
      "--search",
      "fixture +%",
      "--status",
      "pending",
      "--deployment-status",
      "draft",
      "--template",
      "tokenized_security",
      "--created-after",
      "2026-01-01T00:00:00Z",
      "--created-before",
      "2026-10-29T00:00:00Z",
      "--sort-by",
      "name",
      "--sort-direction",
      "asc",
      "--page",
      "2",
      "--page-size",
      "100",
    ],
    paginated([token])
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, [token]);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    search: "fixture +%",
    status: "pending",
    deploymentStatus: "draft",
    template: "tokenized_security",
    createdAfter: "2026-01-01T00:00:00Z",
    createdBefore: "2026-10-29T00:00:00Z",
    sortBy: "name",
    sortDirection: "asc",
    page: "2",
    pageSize: "100",
  });
  assert.equal(result.requests.length, 1);
});

test("issuance history sends repeated type query parameters without flattening or dropping them", async () => {
  const result = await invoke(
    [
      "issuance",
      "transactions",
      "list",
      "--type",
      "burn",
      "--type",
      "force_burn",
      "--custody-wallet-id",
      "cwlt_example",
      "--status",
      "confirmed",
    ],
    paginated([])
  );
  assert.equal(result.code, 0, result.stderr);
  const query = new URL(result.requests[0].url).searchParams;
  assert.deepEqual(query.getAll("type"), ["burn", "force_burn"]);
  assert.equal(query.get("custodyWalletId"), "cwlt_example");
  assert.equal(query.get("status"), "confirmed");
  const legacy = await invoke(
    ["issuance", "transactions", "list", "--wallet-id", "provider_example", "--type", "mint"],
    paginated([])
  );
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(new URL(legacy.requests[0].url).searchParams.get("walletId"), "provider_example");
  const scalar = await invoke(
    [
      "issuance",
      "tokens",
      "transactions",
      "list",
      token.id,
      "--type",
      "burn",
      "--page-size",
      "500",
    ],
    paginated([])
  );
  assert.equal(scalar.code, 0, scalar.stderr);
  assert.deepEqual(new URL(scalar.requests[0].url).searchParams.getAll("type"), ["burn"]);
  const repeatedScalar = await invoke(
    ["issuance", "tokens", "transactions", "list", token.id, "--type", "burn", "--type", "mint"],
    paginated([])
  );
  assert.equal(repeatedScalar.code, 2);
  assert.equal(repeatedScalar.requests.length, 0);
});

test("authority resolution remains opt-in and returns public authority values exactly as supplied", async () => {
  const data = {
    token,
    allowlistAuthority: SOL_MINT,
    freezeAuthority: null,
    metadataAuthority: SOL_MINT,
    pauseAuthority: null,
  };
  const plain = await invoke(["issuance", "tokens", "get", token.id], response({ token }));
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(new URL(plain.requests[0].url).search, "");
  const selected = await invoke(
    [
      "issuance",
      "tokens",
      "get",
      token.id,
      "--include-allowlist-authority",
      "true",
      "--include-freeze-authority",
      "false",
      "--include-metadata-authority",
      "true",
      "--include-pause-authority",
      "false",
    ],
    response(data)
  );
  assert.equal(selected.code, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).data, data);
  assert.deepEqual(Object.fromEntries(new URL(selected.requests[0].url).searchParams), {
    includeAllowlistAuthority: "true",
    includeFreezeAuthority: "false",
    includeMetadataAuthority: "true",
    includePauseAuthority: "false",
  });
});

test("prepare and execute mint retain nested amounts and zero/false options without automatic execution", async () => {
  const options = { priorityFee: 0, simulate: false };
  for (const verb of ["execute", "build-unsigned-transaction"]) {
    const data: JsonObject = { transaction, tokenAccount: SOL_MINT };
    if (verb === "build-unsigned-transaction") {
      data.preparedTransaction = preparedTransaction;
      data.simulation = {
        success: false,
        logs: [],
        unitsConsumed: "9007199254740993",
        error: "Simulation fixture",
      };
    }
    const args = [
      "issuance",
      "tokens",
      "mint",
      verb,
      token.id,
      "--mint",
      JSON.stringify(mintTerms),
      "--signing-custody-wallet-id",
      "cwlt_current",
      "--options",
      JSON.stringify(options),
    ];
    if (verb === "execute") args.push("--idempotency-key", "mint-intent-42");
    const result = await invoke(args, response(data));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {
      mint: mintTerms,
      signingCustodyWalletId: "cwlt_current",
      options,
    });
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
  }
});

test("burn, enforcement and authority requests keep their distinct nested objects and actions", async () => {
  for (const [verb, flag, terms, field] of [
    [["burn", "execute"], "burn", burnTerms, "burn"],
    [["seize", "execute"], "seize", seizeTerms, "seize"],
    [["force-burn", "execute"], "force-burn", burnTerms, "forceBurn"],
    [["authority", "update", "execute"], "authority", authorityTerms, "authority"],
  ] as const) {
    const result = await invoke(
      [
        "issuance",
        "tokens",
        ...verb,
        token.id,
        `--${flag}`,
        JSON.stringify(terms),
        "--signing-custody-wallet-id",
        "cwlt_current",
        "--idempotency-key",
        "intent-42",
      ],
      response({ transaction })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {
      [field]: terms,
      signingCustodyWalletId: "cwlt_current",
    });
    assert.equal(result.requests.length, 1);
  }
});

test("deploy preparation returns caller-signable bytes and follow-up terms without confirmation or submission", async () => {
  const data = {
    transaction: preparedTransaction,
    mint: SOL_MINT,
    metadataUriFollowUp: { required: true, uri: "https://example.test/metadata.json" },
  };
  const result = await invoke(
    [
      "issuance",
      "tokens",
      "deploy",
      "build-unsigned-transaction",
      token.id,
      "--signing-wallet-id",
      "provider_example",
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { signingWalletId: "provider_example" });
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
  const metadata = await invoke(
    ["issuance", "tokens", "deploy", "metadata", "build-unsigned-transaction", token.id],
    response({ transaction: null, uri: "https://example.test/metadata.json" })
  );
  assert.equal(metadata.code, 0, metadata.stderr);
  assert.deepEqual(body(metadata.requests[0]), {});
  assert.equal(JSON.parse(metadata.stdout).data.transaction, null);
  const confirmed = await invoke(
    [
      "issuance",
      "tokens",
      "deploy",
      "confirm-submitted-transaction",
      token.id,
      "--signature",
      "1".repeat(64),
      "--mint-address",
      SOL_MINT,
    ],
    response({ token })
  );
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.deepEqual(body(confirmed.requests[0]), { signature: "1".repeat(64), mint: SOL_MINT });
  assert.equal(confirmed.requests.length, 1);
});

test("managed deployment and empty-body pause operations preserve the server's chosen defaults", async () => {
  const deployed = await invoke(
    [
      "issuance",
      "tokens",
      "deploy",
      "execute",
      token.id,
      "--authority-wallets",
      '{"metadata":"cwlt_meta"}',
      "--fee-payment",
      "sponsored",
      "--idempotency-key",
      "deploy-42",
    ],
    response({ token })
  );
  assert.equal(deployed.code, 0, deployed.stderr);
  assert.deepEqual(body(deployed.requests[0]), {
    authorityCustodyWalletIds: { metadata: "cwlt_meta" },
    feePayment: "sponsored",
  });
  for (const verb of ["pause", "unpause"]) {
    const result = await invoke(["issuance", "tokens", verb, token.id], response({ transaction }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {});
    assert.equal(result.requests.length, 1);
  }
});

test("allowlist search, labels and signer selection stay in their declared query fields", async () => {
  const list = await invoke(
    [
      "issuance",
      "tokens",
      "control-list",
      "list",
      token.id,
      "--search",
      "wallet+%",
      "--label",
      "desk A",
      "--page-size",
      "500",
    ],
    paginated([])
  );
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(Object.fromEntries(new URL(list.requests[0].url).searchParams), {
    search: "wallet+%",
    label: "desk A",
    pageSize: "500",
  });
  const removed = await invoke(
    [
      "issuance",
      "tokens",
      "control-list",
      "remove",
      token.id,
      "entry/with?#",
      "--signing-custody-wallet-id",
      "cwlt_current",
    ],
    new Response(null, { status: 204 })
  );
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.stdout, "");
  assert.equal(removed.requests[0].init.body, undefined);
  assert.equal(
    new URL(removed.requests[0].url).pathname,
    `/v1/issuance/tokens/${token.id}/control-list/entry%2Fwith%3F%23`
  );
  assert.deepEqual(Object.fromEntries(new URL(removed.requests[0].url).searchParams), {
    signingCustodyWalletId: "cwlt_current",
  });
});

test("holder enrollment and holder paging preserve identity and review metadata without KYC automation", async () => {
  const enrollment = { id: "enrollment_fixture", reviewMode: "manual", status: "active" };
  const enrolled = await invoke(
    [
      "issuance",
      "tokens",
      "holder-enrollments",
      "create",
      token.id,
      "--wallet-address",
      SOL_MINT,
      "--counterparty-id",
      "cpty_example",
      "--review-mode",
      "manual",
    ],
    response({ enrollment }, 201)
  );
  assert.equal(enrolled.code, 0, enrolled.stderr);
  assert.deepEqual(body(enrolled.requests[0]), {
    walletAddress: SOL_MINT,
    counterpartyId: "cpty_example",
    reviewMode: "manual",
  });
  const data = { holders: [{ enrollment }], total: 1, page: 2, pageSize: 200 };
  const list = await invoke(
    [
      "issuance",
      "tokens",
      "holder-enrollments",
      "list",
      token.id,
      "--page",
      "2",
      "--page-size",
      "200",
    ],
    response(data)
  );
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).data, data);
  assert.equal(new URL(list.requests[0].url).searchParams.get("pageSize"), "200");
});

test("profile field options, filtered lists, by-token reads and archive use the API resource model", async () => {
  const fields = {
    categories: [...ASSET_CATEGORIES],
    types: Object.fromEntries(
      ASSET_CATEGORIES.map((category) => [category, [...ASSET_TYPES[category]]])
    ),
  };
  const options = await invoke(["asset-profiles", "field-options", "get"], response({ fields }));
  assert.equal(options.code, 0, options.stderr);
  assert.deepEqual(JSON.parse(options.stdout).data.fields, fields);
  const data = { assetProfiles: [profile], total: 1, page: 1, pageSize: 20 };
  const list = await invoke(
    [
      "asset-profiles",
      "list",
      "--include-archived",
      "--category",
      "generic",
      "--token-ids",
      "tok_one,tok_two",
    ],
    response(data)
  );
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(Object.fromEntries(new URL(list.requests[0].url).searchParams), {
    includeArchived: "true",
    category: "generic",
    tokenIds: "tok_one,tok_two",
  });
  const linked = await invoke(
    ["asset-profiles", "get-by-token", token.id],
    response({ assetProfile: profile })
  );
  assert.equal(linked.code, 0, linked.stderr);
  assert.equal(
    new URL(linked.requests[0].url).pathname,
    `/v1/issuance/asset-profiles/by-token/${token.id}`
  );
  const archived = await invoke(
    ["asset-profiles", "archive", profile.id],
    new Response(null, { status: 204 })
  );
  assert.equal(archived.code, 0, archived.stderr);
  assert.equal(archived.stdout, "");
  assert.equal(archived.requests[0].init.method, "DELETE");
});

test("literal routes cannot be selected as token or profile IDs", async () => {
  for (const args of [
    ["issuance", "tokens", "get", "facets"],
    ["asset-profiles", "get", "field-options"],
  ]) {
    const result = await invoke(args, error());
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});

test("invalid decimals, nested requests, booleans, query enums and mutation flags fail locally", async () => {
  for (const args of [
    ["issuance", "tokens", "create", "--name", token.name, "--symbol", "../BAD"],
    [
      "issuance",
      "tokens",
      "create",
      "--name",
      token.name,
      "--symbol",
      token.symbol,
      "--decimals",
      "19",
    ],
    [
      "issuance",
      "tokens",
      "create",
      "--name",
      token.name,
      "--symbol",
      token.symbol,
      "--mintable",
      "0",
    ],
    [
      "issuance",
      "tokens",
      "mint",
      "execute",
      token.id,
      "--mint",
      JSON.stringify({ ...mintTerms, amount: 10 }),
    ],
    ["issuance", "tokens", "burn", "execute", token.id, "--burn", JSON.stringify(burnTerms)],
    ["issuance", "tokens", "mint", "execute", token.id, "--mint", "[]"],
    ["issuance", "tokens", "get", token.id, "--include-metadata-authority", "yes"],
    ["issuance", "tokens", "list", "--page-size", "101"],
    ["issuance", "tokens", "list", "--deployment-status", "pending"],
    ["issuance", "transactions", "list", "--type", "invalid_type"],
    ["issuance", "tokens", "holder-enrollments", "list", token.id, "--page-size", "201"],
    [
      "issuance",
      "tokens",
      "mint",
      "build-unsigned-transaction",
      token.id,
      "--mint",
      JSON.stringify(mintTerms),
      "--idempotency-key",
      "not-supported",
    ],
    [
      "issuance",
      "tokens",
      "create-with-asset-profile",
      "--data",
      JSON.stringify({ ...create, publicMetadata: { leak: "private" } }),
    ],
    ["asset-profiles", "update", profile.id],
    ["issuance", "tokens", "update", token.id],
  ]) {
    const result = await invoke(args, error());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0);
  }
});

test("server-owned category, signer, amount and deployment policy errors remain visible without retries", async () => {
  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [403, "INSUFFICIENT_PERMISSIONS"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [422, "TRANSACTION_FAILED"],
    [429, "RATE_LIMITED"],
    [502, "SOLANA_RPC_ERROR"],
  ] as const) {
    const result = await invoke(
      [
        "issuance",
        "tokens",
        "mint",
        "execute",
        token.id,
        "--mint",
        JSON.stringify(mintTerms),
        "--idempotency-key",
        "intent-42",
      ],
      error(status, code)
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, code);
    assert.equal(result.requests.length, 1);
  }
  const failure = await invoke(
    [
      "issuance",
      "tokens",
      "mint",
      "execute",
      token.id,
      "--mint",
      JSON.stringify(mintTerms),
      "--idempotency-key",
      "intent-42",
    ],
    response({ transaction, tokenAccount: SOL_MINT }),
    { failure: new TypeError("connection lost") }
  );
  assert.equal(failure.code, 1);
  assert.equal(failure.requests.length, 1);
});

test("malformed financial or public metadata responses produce no partial stdout", async () => {
  for (const [args, data] of [
    [["issuance", "tokens", "get", token.id], { token: { ...token, totalSupply: 10 } }],
    [
      ["issuance", "tokens", "deploy", "build-unsigned-transaction", token.id],
      { transaction: { ...preparedTransaction, lastValidBlockHeight: 10 }, mint: SOL_MINT },
    ],
  ] as const) {
    const result = await invoke([...args], response(data));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
  }
  const publicResult = await invoke(
    ["issuance", "tokens", "metadata", "get", token.id],
    Response.json({ name: token.name })
  );
  assert.equal(publicResult.code, 1);
  assert.equal(publicResult.stdout, "");
});
