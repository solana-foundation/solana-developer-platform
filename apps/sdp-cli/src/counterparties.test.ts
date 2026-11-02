import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_counterparties", timestamp: "2026-01-01T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "counterparty-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "counterparty-key", SDP_API_URL: session.SDP_API_URL };
const counterparty = {
  id: "cpty_example",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  externalId: "customer_42",
  entityType: "individual",
  displayName: "Example",
  status: "active",
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const details = { network: "solana", address: SOL_MINT };
const account = {
  id: "cpa_example",
  organizationId: counterparty.organizationId,
  projectId: session.SDP_PROJECT_ID,
  counterpartyId: counterparty.id,
  accountKind: "crypto_wallet",
  label: null,
  details,
  providerAccountData: {},
  status: "active",
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const createArgs = [
  "counterparties",
  "create",
  "--entity-type",
  "individual",
  "--display-name",
  "Example",
];
const accountCreateArgs = [
  "counterparties",
  "accounts",
  "create",
  counterparty.id,
  "--account-kind",
  "crypto_wallet",
  "--details",
  JSON.stringify(details),
];
const requirementsArgs = [
  "counterparties",
  "ramp-requirements",
  "get",
  counterparty.id,
  "--provider",
  "moonpay",
  "--direction",
  "onramp",
  "--asset-rail",
  "usdc.solana",
  "--fiat-currency",
  "USD",
  "--destination-custody-wallet-id",
  "cwlt_destination",
];
const allCommands = [
  ["counterparties", "field-options", "get"],
  ["counterparties", "list"],
  ["counterparties", "get", counterparty.id],
  createArgs,
  ["counterparties", "update", counterparty.id, "--display-name", "Updated"],
  ["counterparties", "archive", counterparty.id],
  requirementsArgs,
  [
    "counterparties",
    "ramp-requirements",
    "check",
    counterparty.id,
    "--provider",
    "moonpay",
    "--direction",
    "onramp",
  ],
  ["counterparties", "provider-accounts", "list", counterparty.id],
  ["counterparties", "project-accounts", "list"],
  ["counterparties", "accounts", "list", counterparty.id],
  ["counterparties", "accounts", "get", counterparty.id, account.id],
  accountCreateArgs,
  ["counterparties", "accounts", "update", counterparty.id, account.id, "--label", "Updated"],
  ["counterparties", "accounts", "archive", counterparty.id, account.id],
];

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
    env: options.env ?? session,
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
function counterpartyResponse(status = 200) {
  return Response.json({ data: { counterparty }, meta }, { status });
}
function accountResponse(status = 200) {
  return Response.json({ data: { account }, meta }, { status });
}
function requestBody(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}

test("counterparty help covers every operation and its action without credentials", async () => {
  for (const args of [
    ["counterparties"],
    ["counterparties", "accounts"],
    ...allCommands.map((args) => [...args, "--help"]),
  ]) {
    const result = await invoke(args, counterpartyResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[1] === "accounts" && args[2] === "create") {
      assert(result.stdout.includes("counterparties.execute"));
      assert(result.stdout.includes("<counterpartyId>"));
    }
    if (args[1] === "accounts" && args[2] === "get")
      assert(result.stdout.includes("<counterpartyAccountId>"));
  }
});

test("all counterparty operations require project selection for a session", async () => {
  for (const args of allCommands) {
    const result = await invoke(args, counterpartyResponse(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("account destination changes retain execute grants and archives retain manage grants", () => {
  for (const id of [
    "createCounterpartyAccount",
    "updateCounterpartyAccount",
    "submitCounterpartyRequirements",
  ])
    assert.deepEqual(operationById(id).authorization, {
      kind: "action",
      action: "counterparties.execute",
    });
  for (const id of [
    "createCounterparty",
    "updateCounterparty",
    "archiveCounterparty",
    "archiveCounterpartyAccount",
  ])
    assert.deepEqual(operationById(id).authorization, {
      kind: "action",
      action: "counterparties.manage",
    });
});

test("metadata preserves canonical field options and countries", async () => {
  const data = {
    fields: {
      entityTypes: COUNTERPARTY_ENTITY_TYPES,
      countries: [{ code: "US", name: "United States" }],
    },
  };
  const result = await invoke(
    ["counterparties", "field-options", "get"],
    Response.json({ data, meta }),
    {
      env: apiKey,
    }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/counterparties/field-options");
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(new Headers(result.requests[0].init.headers).get("x-project-id"), null);
});

test("list pagination and archives remain explicit and preserve the complete result", async () => {
  const data = {
    counterparties: [{ ...counterparty, status: "archived" }],
    total: 41,
    page: 2,
    pageSize: 20,
  };
  const result = await invoke(
    ["counterparties", "list", "--page", "2", "--page-size", "20", "--include-archived"],
    Response.json({ data, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/counterparties?page=2&pageSize=20&includeArchived=true"
  );
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
  const omitted = await invoke(["counterparties", "list"], Response.json({ data, meta }));
  assert.equal(omitted.code, 0, omitted.stderr);
  assert.equal(omitted.requests[0].url, "http://localhost:8787/v1/counterparties");
});

test("counterparty creation sends identity fields and the optional idempotency key once", async () => {
  const result = await invoke(
    [...createArgs, "--external-id", "customer_42", "--idempotency-key", "create-counterparty-1"],
    counterpartyResponse(201),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "POST");
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/counterparties");
  assert.deepEqual(requestBody(result.requests[0]), {
    entityType: "individual",
    displayName: "Example",
    externalId: "customer_42",
  });
  assert.equal(
    new Headers(result.requests[0].init.headers).get("idempotency-key"),
    "create-counterparty-1"
  );
  assert.equal(result.requests.length, 1);
});

test("counterparty and account creation accept inline JSON, files and stdin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-counterparty-"));
  try {
    for (const [args, body, response] of [
      [
        ["counterparties", "create"],
        { entityType: "business", displayName: "Example" },
        counterpartyResponse,
      ],
      [
        ["counterparties", "accounts", "create", counterparty.id],
        { accountKind: "crypto_wallet", details, providerAccountData: {} },
        accountResponse,
      ],
    ] as const) {
      const text = JSON.stringify(body);
      const file = path.join(directory, "body.json");
      await writeFile(file, text);
      for (const source of [text, `@${file}`, "-"]) {
        const result = await invoke([...args, "--data", source], response(201), { stdin: text });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(requestBody(result.requests[0]), body);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counterparty updates preserve omitted fields and clear external IDs with explicit null", async () => {
  for (const [args, body] of [
    [["--clear-external-id"], { externalId: null }],
    [["--entity-type", "business"], { entityType: "business" }],
    [
      ["--display-name", "Updated", "--external-id", "external_new"],
      { displayName: "Updated", externalId: "external_new" },
    ],
    [["--data", '{"externalId":null}'], { externalId: null }],
  ] as const) {
    const result = await invoke(
      ["counterparties", "update", counterparty.id, ...args],
      counterpartyResponse()
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "PATCH");
    assert.deepEqual(requestBody(result.requests[0]), body);
  }
});

test("parent and account IDs are encoded independently as single path segments", async () => {
  const parent = "parent/with?#";
  const child = "account/with?#";
  const result = await invoke(
    ["counterparties", "accounts", "get", parent, child],
    accountResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/counterparties/parent%2Fwith%3F%23/accounts/account%2Fwith%3F%23"
  );
  const parentResult = await invoke(["counterparties", "get", parent], counterpartyResponse());
  assert.equal(parentResult.code, 0, parentResult.stderr);
  assert.equal(
    new URL(parentResult.requests[0].url).pathname,
    "/v1/counterparties/parent%2Fwith%3F%23"
  );
});

test("metadata and project account routes cannot be mistaken for counterparty IDs", async () => {
  for (const id of ["field-options", "accounts"]) {
    const result = await invoke(["counterparties", "get", id], counterpartyResponse());
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("different API route"));
  }
});

test("archives send no body and emit no output for HTTP 204", async () => {
  for (const args of [
    ["counterparties", "archive", counterparty.id],
    ["counterparties", "accounts", "archive", counterparty.id, account.id],
  ]) {
    const result = await invoke(
      [...args, "--idempotency-key", "archive-1"],
      new Response(null, { status: 204 }),
      { env: apiKey }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.requests[0].init.method, "DELETE");
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), "archive-1");
  }
});

test("nested account lists forward pagination, kind, and archive filters", async () => {
  const data = { accounts: [account], total: 3, page: 1, pageSize: 2 };
  const result = await invoke(
    [
      "counterparties",
      "accounts",
      "list",
      counterparty.id,
      "--page",
      "1",
      "--page-size",
      "2",
      "--account-kind",
      "crypto_wallet",
      "--include-archived",
    ],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    page: "1",
    pageSize: "2",
    includeArchived: "true",
    accountKind: "crypto_wallet",
  });
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
});

test("account creation sends complete JSON details and open provider metadata in the body", async () => {
  const providerAccountData = {
    reference: "external_42",
    flags: [true, null],
    extra: { value: 0 },
  };
  const result = await invoke(
    [
      ...accountCreateArgs,
      "--label",
      "Treasury",
      "--provider-account-data",
      JSON.stringify(providerAccountData),
      "--idempotency-key",
      "account-create-1",
    ],
    accountResponse(201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    `http://localhost:8787/v1/counterparties/${counterparty.id}/accounts`
  );
  assert.deepEqual(requestBody(result.requests[0]), {
    accountKind: "crypto_wallet",
    label: "Treasury",
    details,
    providerAccountData,
  });
  assert.equal(
    new Headers(result.requests[0].init.headers).get("x-project-id"),
    session.SDP_PROJECT_ID
  );
  assert.equal(result.requests.length, 1);
});

test("account updates clear labels and preserve explicit empty metadata without extra reads", async () => {
  for (const [args, body] of [
    [["--clear-label"], { label: null }],
    [
      ["--details", JSON.stringify(details), "--provider-account-data", "{}"],
      { details, providerAccountData: {} },
    ],
    [
      ["--data", '{"label":null,"providerAccountData":{}}'],
      { label: null, providerAccountData: {} },
    ],
  ] as const) {
    const result = await invoke(
      [
        "counterparties",
        "accounts",
        "update",
        counterparty.id,
        account.id,
        ...args,
        "--idempotency-key",
        "account-update-1",
      ],
      accountResponse()
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "PATCH");
    assert.deepEqual(requestBody(result.requests[0]), body);
    assert.equal(result.requests.length, 1);
  }
});

test("project-wide account lookup forwards search and comma-separated IDs without expanding results", async () => {
  const data = {
    accounts: [
      {
        counterpartyId: counterparty.id,
        counterpartyAccountId: account.id,
        name: counterparty.displayName,
        address: SOL_MINT,
        label: null,
      },
    ],
    total: 1,
    page: 3,
    pageSize: 1,
  };
  const result = await invoke(
    [
      "counterparties",
      "project-accounts",
      "list",
      "--type",
      "crypto_account",
      "--search",
      "Example & Co",
      "--ids",
      "cpa_one,cpa_two",
      "--page",
      "3",
      "--page-size",
      "1",
    ],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  const url = new URL(result.requests[0].url);
  assert.equal(url.pathname, "/v1/counterparties/accounts");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    type: "crypto_account",
    page: "3",
    pageSize: "1",
    search: "Example & Co",
    ids: "cpa_one,cpa_two",
  });
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("requirements queries preserve ready, collect and unsupported states", async () => {
  for (const state of [
    { status: "ready" },
    {
      status: "collect",
      fields: [
        { kind: "country", key: "country", label: "Country", required: true, options: ["US"] },
        {
          kind: "address",
          key: "address",
          label: "Address",
          required: false,
          fields: [{ kind: "text", key: "line1", label: "Street", required: true }],
        },
      ],
    },
    { status: "unsupported", reason: "Unsupported corridor" },
  ]) {
    const data = { provider: "moonpay", direction: "onramp", ...state };
    const result = await invoke(requirementsArgs, Response.json({ data, meta }), { env: apiKey });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
      provider: "moonpay",
      direction: "onramp",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      destinationCustodyWalletId: "cwlt_destination",
    });
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("requirements submission sends only provider and direction, with no query or retry key", async () => {
  for (const args of [
    ["--provider", "stripe", "--direction", "onramp"],
    ["--data", '{"provider":"stripe","direction":"onramp"}'],
  ]) {
    const data = { provider: "stripe", direction: "onramp", status: "ready" };
    const result = await invoke(
      ["counterparties", "ramp-requirements", "check", counterparty.id, ...args],
      Response.json({ data, meta }),
      { env: apiKey }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.requests[0].url,
      `http://localhost:8787/v1/counterparties/${counterparty.id}/ramp-requirements/check`
    );
    assert.equal(result.requests[0].init.method, "POST");
    assert.deepEqual(requestBody(result.requests[0]), { provider: "stripe", direction: "onramp" });
    assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
  }
});

test("provider-account filtering preserves provider references and balance availability", async () => {
  const row = {
    id: "cpa_provider",
    provider: "moonpay",
    kind: "funding_wallet",
    fiatCurrency: "USD",
    destinationCountry: "US",
    paymentRail: null,
    status: "active",
    providerStatus: null,
    createdAt: meta.timestamp,
    providerAccountReference: "provider_reference",
  };
  for (const balance of [
    { state: "available", amount: "9007199254740993.123456", currency: "USD" },
    { state: "unavailable" },
  ]) {
    const data = { accounts: [{ ...row, balance }] };
    const result = await invoke(
      [
        "counterparties",
        "provider-accounts",
        "list",
        counterparty.id,
        "--provider",
        "moonpay",
        "--fiat-currency",
        "USD",
        "--destination-country",
        "US",
      ],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
      provider: "moonpay",
      fiatCurrency: "USD",
      destinationCountry: "US",
    });
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  }
});

test("invalid usage, empty patches and unsupported fields make no requests", async () => {
  const cases = [
    ["counterparties", "create"],
    [...createArgs, "--external-id", ""],
    [...createArgs, "--display-name", "x".repeat(513)],
    ["counterparties", "create", "--data", '{"entityType":"unknown","displayName":"X"}'],
    [...createArgs, "--data", "{}"],
    ["counterparties", "update", counterparty.id],
    ["counterparties", "update", counterparty.id, "--data", "{}"],
    ["counterparties", "update", counterparty.id, "--external-id", "x", "--clear-external-id"],
    ["counterparties", "update", counterparty.id, "--data", '{"providerData":{"ssn":"refused"}}'],
    ["counterparties", "get", ".."],
    ["counterparties", "list", "--page", "0"],
    ["counterparties", "list", "--page-size", "101"],
    ["counterparties", "accounts", "get", counterparty.id],
    ["counterparties", "accounts", "get", counterparty.id, ".."],
    ["counterparties", "accounts", "create", counterparty.id, "--account-kind", "bank_account"],
    ["counterparties", "accounts", "create", counterparty.id, "--details", "[]"],
    [...accountCreateArgs, "--provider-account-data", "null"],
    ["counterparties", "accounts", "update", counterparty.id, account.id],
    ["counterparties", "accounts", "update", counterparty.id, account.id, "--data", "{}"],
    [
      "counterparties",
      "accounts",
      "update",
      counterparty.id,
      account.id,
      "--label",
      "X",
      "--clear-label",
    ],
    [
      "counterparties",
      "accounts",
      "update",
      counterparty.id,
      account.id,
      "--data",
      '{"accountKind":"crypto_wallet"}',
    ],
    ["counterparties", "project-accounts", "list", "--search", "x".repeat(257)],
    ["counterparties", "project-accounts", "list", "--type", "invalid"],
    ["counterparties", "ramp-requirements", "get", counterparty.id],
    [...requirementsArgs, "--provider", "privy"],
    [...requirementsArgs, "--asset-rail", "invalid"],
    [...requirementsArgs, "--fiat-currency", "XXX"],
    [
      "counterparties",
      "ramp-requirements",
      "check",
      counterparty.id,
      "--data",
      '{"provider":"moonpay","direction":"onramp","ssn":"refused"}',
    ],
    [
      "counterparties",
      "ramp-requirements",
      "check",
      counterparty.id,
      "--provider",
      "moonpay",
      "--direction",
      "onramp",
      "--idempotency-key",
      "unsupported",
    ],
    ["counterparties", "provider-accounts", "list", counterparty.id, "--destination-country", "ZZ"],
    ["counterparties", "provider-accounts", "list", counterparty.id, "--provider", "privy"],
    ["wallets", "list", "--provider", "moonpay"],
  ];
  for (const args of cases) {
    const result = await invoke(args, counterpartyResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("server-side refinements, conflicts, provider gates and quotas remain single-request errors", async () => {
  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [422, "IDEMPOTENCY_KEY_REUSED"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    const result = await invoke(
      accountCreateArgs,
      Response.json({ error: { code, message: "Request refused" }, meta }, { status })
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.status, status);
    assert.equal(JSON.parse(result.stderr).error.code, code);
    assert.equal(JSON.parse(result.stderr).error.requestId, meta.requestId);
    assert.equal(result.stdout, "");
  }
  const failed = await invoke(createArgs, counterpartyResponse(201), {
    failure: new DOMException("upstream private details", "TimeoutError"),
  });
  assert.equal(failed.code, 1);
  assert.equal(failed.requests.length, 1);
  assert(!failed.stderr.includes("upstream private details"));
});

test("malformed account and requirements responses fail without emitting partial output", async () => {
  for (const [args, data] of [
    [
      ["counterparties", "accounts", "get", counterparty.id, account.id],
      { account: { id: account.id } },
    ],
    [requirementsArgs, { provider: "moonpay", direction: "onramp", status: "collect" }],
    [
      ["counterparties", "project-accounts", "list"],
      { accounts: [], page: 0, pageSize: 20, total: 0 },
    ],
  ] as const) {
    const result = await invoke([...args], Response.json({ data, meta }));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert.equal(result.stdout, "");
  }
});
