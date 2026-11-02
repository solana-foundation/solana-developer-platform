import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES,
  PAYMENT_SUBSCRIPTION_PLAN_STATUSES,
  PAYMENT_SUBSCRIPTION_STATUSES,
} from "@sdp/types/payments";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { operationById } from "./contract";
import { runCli } from "./run";

const mint = wellKnownMint("USDC", "devnet");
assert(mint);
const meta = { requestId: "req_recurring", timestamp: "2026-01-01T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "recurring-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "recurring-key", SDP_API_URL: session.SDP_API_URL };
const recurring = {
  id: "prp_example",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  sourceCustodyWalletId: "cwlt_source",
  sourceProviderWalletId: "provider_source",
  sourceAddress: SOL_MINT,
  counterpartyId: "cpty_example",
  counterpartyAccountId: "cpa_example",
  destinationAddress: SOL_MINT,
  destinationTokenAccount: null,
  token: mint,
  amount: "25.000001",
  periodHours: 720,
  firstCollectionAt: null,
  nextCollectionDueAt: null,
  planId: null,
  subscriptionId: null,
  planPda: null,
  planCreatedAt: null,
  planCreationSignature: null,
  subscriptionPda: null,
  subscriptionAuthorityAddress: null,
  authorizationSignature: null,
  status: "pending_activation",
  pausedReason: null,
  metadataUri: null,
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const plan = {
  id: "psp_example",
  organizationId: recurring.organizationId,
  projectId: session.SDP_PROJECT_ID,
  ownerWalletId: "provider_owner",
  ownerAddress: SOL_MINT,
  token: mint,
  amount: "25.000001",
  periodHours: 720,
  programPlanId: "18446744073709551615",
  planPda: null,
  destinationAddress: null,
  pullerWalletId: null,
  pullerAddress: null,
  metadataUri: null,
  status: "draft",
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const subscription = {
  id: "psub_example",
  organizationId: recurring.organizationId,
  projectId: session.SDP_PROJECT_ID,
  planId: plan.id,
  counterpartyId: recurring.counterpartyId,
  subscriberAddress: SOL_MINT,
  subscriberTokenAccount: null,
  subscriptionPda: null,
  subscriptionAuthorityAddress: null,
  authorizationSignature: null,
  status: "pending_authorization",
  currentPeriodStartAt: null,
  nextCollectionDueAt: null,
  cancelAt: null,
  canceledAt: null,
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const attempt = {
  id: "psca_example",
  organizationId: recurring.organizationId,
  projectId: session.SDP_PROJECT_ID,
  subscriptionId: subscription.id,
  transferId: "xfr_example",
  token: mint,
  amount: "25.000001",
  dueAt: meta.timestamp,
  attemptedAt: meta.timestamp,
  status: "processing",
  signature: "signature_fixture",
  error: null,
  metadata: { recurringPaymentId: recurring.id, initiatedByKeyId: null, source: "manual" },
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const transfer = {
  id: "xfr_example",
  organizationId: recurring.organizationId,
  custodyWalletId: recurring.sourceCustodyWalletId,
  providerWalletId: recurring.sourceProviderWalletId,
  type: "transfer",
  kind: "recurring_pay",
  direction: "outbound",
  status: "processing",
  signature: "signature_fixture",
  serializedTx: null,
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  rampsMemo: {},
  token: mint,
  amount: "25.000001",
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const preparedTransaction = {
  serialized: "AQIDBA==",
  blockhash: "blockhash_fixture",
  lastValidBlockHeight: "9007199254740993",
  requiredSigners: [SOL_MINT],
};
const recurringArgs = [
  "--source-custody-wallet-id",
  "cwlt_source",
  "--counterparty-id",
  "cpty_example",
  "--counterparty-account-id",
  "cpa_example",
  "--asset",
  "USDC",
  "--amount",
  "25.000001",
  "--period-hours",
  "720",
];
const planArgs = [
  "--owner-wallet-id",
  "provider_owner",
  "--asset",
  "USDC",
  "--amount",
  "25.000001",
  "--period-hours",
  "720",
];
const subscriptionArgs = [
  "--plan-id",
  plan.id,
  "--counterparty-id",
  recurring.counterpartyId,
  "--subscriber-address",
  SOL_MINT,
];
const authorizationArgs = [
  "--subscriber-token-account",
  SOL_MINT,
  "--expected-plan-created-at",
  "18446744073709551615",
  "--expected-subscription-authority-init-id=-9223372036854775808",
];
const lifecycleCommands = [
  ["recurring-payments", "activate", recurring.id],
  ["recurring-payments", "cancel", recurring.id],
  ["recurring-payments", "collect", recurring.id],
  ["recurring-payments", "resume", recurring.id],
];
const commands = [
  ["recurring-payments", "create", ...recurringArgs, "--idempotency-key", "schedule-1"],
  ["recurring-payments", "list"],
  ["recurring-payments", "get", recurring.id],
  ["recurring-payments", "update", recurring.id, "--amount", "30", "--idempotency-key", "edit-1"],
  ...lifecycleCommands.map((args) => [...args, "--idempotency-key", "lifecycle-1"]),
  ["subscription-plans", "create-record", ...planArgs],
  ["subscription-plans", "list"],
  ["subscription-plans", "get", plan.id],
  ["subscription-plans", "update", plan.id, "--clear-metadata-uri"],
  ["subscription-plans", "create", "build-unsigned-transaction", plan.id],
  ["subscriptions", "create-record", ...subscriptionArgs],
  ["subscriptions", "list"],
  ["subscriptions", "get", subscription.id],
  [
    "subscriptions",
    "authorize",
    "build-unsigned-transaction",
    subscription.id,
    ...authorizationArgs,
  ],
  ["subscriptions", "cancel", "build-unsigned-transaction", subscription.id],
  ["subscriptions", "resume", "build-unsigned-transaction", subscription.id],
  [
    "subscriptions",
    "collect",
    "build-unsigned-transaction",
    subscription.id,
    "--receiver-token-account",
    SOL_MINT,
  ],
  ["subscriptions", "collection-attempts", "list", subscription.id],
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
function recurringResponse(status = 200) {
  return Response.json({ data: { recurringPayment: recurring }, meta }, { status });
}
function planResponse(status = 200) {
  return Response.json({ data: { subscriptionPlan: plan }, meta }, { status });
}
function subscriptionResponse(status = 200) {
  return Response.json({ data: { subscription }, meta }, { status });
}
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function headers(request: RecordedRequest) {
  return new Headers(request.init.headers);
}

test("all 21 commands provide help describing preparation versus execution without credentials", async () => {
  assert.equal(commands.length, 21);
  for (const args of [
    ["recurring-payments"],
    ["subscription-plans"],
    ["subscriptions"],
    ...commands.map((args) => [...args, "--help"]),
  ]) {
    const result = await invoke(args, recurringResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (
      args[0] === "recurring-payments" &&
      args[1] !== "get" &&
      args[1] !== "list" &&
      args[1] !== undefined
    )
      assert(result.stdout.includes("Requires --idempotency-key"));
    if (args[1] === "prepare-authorization")
      assert(result.stdout.includes("signed and submitted by the client"));
  }
});

test("all recurring, plan and subscription operations require a project for sessions", async () => {
  for (const args of commands) {
    const result = await invoke(args, recurringResponse(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("cancel and creation keep manage grants while collection and active edits require execute", () => {
  for (const id of [
    "cancelPaymentRecurringPayment",
    "createPaymentRecurringPayment",
    "createPaymentSubscription",
    "createPaymentSubscriptionPlan",
    "preparePaymentSubscriptionCancel",
  ])
    assert.deepEqual(operationById(id).authorization, {
      kind: "action",
      action: "recurring.manage",
    });
  for (const id of [
    "collectPaymentRecurringPayment",
    "activatePaymentRecurringPayment",
    "resumePaymentRecurringPayment",
    "updatePaymentRecurringPayment",
    "updatePaymentSubscriptionPlan",
    "preparePaymentSubscriptionAuthorization",
    "preparePaymentSubscriptionCollection",
  ])
    assert.deepEqual(operationById(id).authorization, {
      kind: "action",
      action: "recurring.execute",
    });
});

test("recurring creation sends exact source and destination IDs, amounts and scheduling fields", async () => {
  const result = await invoke(
    [
      "recurring-payments",
      "create",
      ...recurringArgs,
      "--first-collection-at",
      "2099-01-01T12:00:00+02:00",
      "--metadata-uri",
      "https://example.com/plan.json",
      "--idempotency-key",
      "schedule-1",
    ],
    recurringResponse(201),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/payments/recurring-payments");
  assert.deepEqual(body(result.requests[0]), {
    sourceCustodyWalletId: "cwlt_source",
    counterpartyId: "cpty_example",
    counterpartyAccountId: "cpa_example",
    token: "USDC",
    amount: "25.000001",
    periodHours: 720,
    firstCollectionAt: "2099-01-01T12:00:00+02:00",
    metadataUri: "https://example.com/plan.json",
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), "schedule-1");
  assert.equal(headers(result.requests[0]).get("x-project-id"), null);
});

test("all recurring mutations require an explicit idempotency key before sending", async () => {
  for (const args of [
    ["recurring-payments", "create", ...recurringArgs],
    ["recurring-payments", "update", recurring.id, "--amount", "30"],
    ...lifecycleCommands,
  ]) {
    const result = await invoke(args, recurringResponse(), { env: apiKey });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Idempotency-Key"));
  }
});

test("recurring updates preserve explicit nulls and do not invent replacement fields", async () => {
  const result = await invoke(
    [
      "recurring-payments",
      "update",
      recurring.id,
      "--clear-first-collection-at",
      "--clear-next-collection-due-at",
      "--clear-metadata-uri",
      "--idempotency-key",
      "edit-1",
    ],
    recurringResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "PATCH");
  assert.deepEqual(body(result.requests[0]), {
    firstCollectionAt: null,
    nextCollectionDueAt: null,
    metadataUri: null,
  });
  assert.equal(result.requests.length, 1);
});

test("lifecycle commands send bodyless POSTs and keep processing collection evidence intact", async () => {
  for (const args of lifecycleCommands) {
    const data =
      args[1] === "collect"
        ? { recurringPayment: recurring, collectionAttempt: attempt, transfer }
        : { recurringPayment: recurring };
    const result = await invoke(
      [...args, "--idempotency-key", "lifecycle-1"],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "POST");
    assert.equal(
      result.requests[0].url,
      `http://localhost:8787/v1/payments/recurring-payments/${recurring.id}/${args[1]}`
    );
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(headers(result.requests[0]).get("content-type"), null);
    assert.equal(headers(result.requests[0]).get("idempotency-key"), "lifecycle-1");
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("recurring lists preserve canonical lifecycle states and nested pagination", async () => {
  for (const status of PAYMENT_RECURRING_PAYMENT_STATUSES) {
    const data = { recurringPayments: [{ ...recurring, status }], total: 12, page: 2, pageSize: 5 };
    const result = await invoke(
      [
        "recurring-payments",
        "list",
        "--status",
        status,
        "--counterparty-id",
        "cpty_example",
        "--page",
        "2",
        "--page-size",
        "5",
      ],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
      status,
      counterpartyId: "cpty_example",
      page: "2",
      pageSize: "5",
    });
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("plan creation uses provider wallet IDs and leaves defaults to the server", async () => {
  const result = await invoke(
    [
      "subscription-plans",
      "create-record",
      ...planArgs,
      "--program-plan-id",
      "18446744073709551615",
      "--idempotency-key",
      "plan-1",
    ],
    planResponse(201),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/payments/subscription-plans");
  assert.deepEqual(body(result.requests[0]), {
    ownerWalletId: "provider_owner",
    token: "USDC",
    amount: "25.000001",
    periodHours: 720,
    programPlanId: "18446744073709551615",
  });
  assert.equal(
    JSON.parse(result.stdout).data.subscriptionPlan.programPlanId,
    "18446744073709551615"
  );
  assert.equal(result.requests.length, 1);
});

test("plan updates clear mutable fields without changing immutable terms", async () => {
  const result = await invoke(
    [
      "subscription-plans",
      "update",
      plan.id,
      "--clear-plan-pda",
      "--clear-destination-address",
      "--clear-puller-wallet-id",
      "--clear-metadata-uri",
      "--status",
      "archived",
    ],
    planResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    planPda: null,
    destinationAddress: null,
    pullerWalletId: null,
    metadataUri: null,
    status: "archived",
  });
  assert.equal(
    result.requests[0].url,
    `http://localhost:8787/v1/payments/subscription-plans/${plan.id}`
  );
});

test("plan preparation preserves explicit empty address arrays and 64-bit end timestamps", async () => {
  const data = { subscriptionPlan: plan, planPda: SOL_MINT, preparedTransaction };
  const result = await invoke(
    [
      "subscription-plans",
      "create",
      "build-unsigned-transaction",
      plan.id,
      "--destinations",
      "[]",
      "--pullers",
      JSON.stringify([SOL_MINT]),
      "--end-ts",
      "18446744073709551615",
    ],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    destinations: [],
    pullers: [SOL_MINT],
    endTs: "18446744073709551615",
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("optional prepare bodies are explicit empty JSON objects without follow-up submissions", async () => {
  for (const [args, data] of [
    [
      ["subscription-plans", "create", "build-unsigned-transaction", plan.id],
      { subscriptionPlan: plan, planPda: SOL_MINT, preparedTransaction },
    ],
    [
      ["subscriptions", "cancel", "build-unsigned-transaction", subscription.id],
      { subscription, preparedTransaction },
    ],
    [
      ["subscriptions", "resume", "build-unsigned-transaction", subscription.id],
      { subscription, preparedTransaction },
    ],
  ] as const) {
    const result = await invoke([...args], Response.json({ data, meta }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {});
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("subscription creation sends only the server-supported pending-record fields", async () => {
  const result = await invoke(
    ["subscriptions", "create-record", ...subscriptionArgs, "--idempotency-key", "subscription-1"],
    subscriptionResponse(201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    planId: plan.id,
    counterpartyId: recurring.counterpartyId,
    subscriberAddress: SOL_MINT,
  });
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/payments/subscriptions");
  assert.equal(result.requests.length, 1);
});

test("subscription authorization preserves unsigned and signed 64-bit consent values as strings", async () => {
  const data = {
    subscription,
    subscriptionPda: SOL_MINT,
    subscriptionAuthorityAddress: SOL_MINT,
    preparedTransaction,
  };
  const result = await invoke(
    [
      "subscriptions",
      "authorize",
      "build-unsigned-transaction",
      subscription.id,
      ...authorizationArgs,
    ],
    Response.json({ data, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    subscriberTokenAccount: SOL_MINT,
    expectedPlanCreatedAt: "18446744073709551615",
    expectedSubscriptionAuthorityInitId: "-9223372036854775808",
  });
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("subscription collection preparation takes only a receiver account and preserves attempt metadata", async () => {
  const data = { subscription, preparedTransaction, collectionAttempt: attempt };
  const result = await invoke(
    [
      "subscriptions",
      "collect",
      "build-unsigned-transaction",
      subscription.id,
      "--receiver-token-account",
      SOL_MINT,
    ],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { receiverTokenAccount: SOL_MINT });
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("subscription and plan list filters validate against their own canonical statuses", async () => {
  for (const status of PAYMENT_SUBSCRIPTION_PLAN_STATUSES) {
    const data = { subscriptionPlans: [{ ...plan, status }], total: 1, page: 1, pageSize: 20 };
    const result = await invoke(
      ["subscription-plans", "list", "--status", status],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).searchParams.get("status"), status);
  }
  for (const status of PAYMENT_SUBSCRIPTION_STATUSES) {
    const data = { subscriptions: [{ ...subscription, status }], total: 1, page: 1, pageSize: 20 };
    const result = await invoke(
      [
        "subscriptions",
        "list",
        "--status",
        status,
        "--plan-id",
        plan.id,
        "--counterparty-id",
        recurring.counterpartyId,
        "--due-before",
        "2099-01-01T12:00:00+02:00",
      ],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
      status,
      planId: plan.id,
      counterpartyId: recurring.counterpartyId,
      dueBefore: "2099-01-01T12:00:00+02:00",
    });
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  }
});

test("collection attempt lists are parent-scoped and preserve each attempt state", async () => {
  for (const status of PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES) {
    const data = { collectionAttempts: [{ ...attempt, status }], total: 7, page: 2, pageSize: 5 };
    const result = await invoke(
      [
        "subscriptions",
        "collection-attempts",
        "list",
        subscription.id,
        "--status",
        status,
        "--page",
        "2",
        "--page-size",
        "5",
      ],
      Response.json({ data, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      new URL(result.requests[0].url).pathname,
      `/v1/payments/subscriptions/${subscription.id}/collection-attempts`
    );
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("all three detail commands encode record IDs in a single URL segment", async () => {
  for (const [family, response] of [
    ["recurring-payments", recurringResponse],
    ["subscription-plans", planResponse],
    ["subscriptions", subscriptionResponse],
  ] as const) {
    const result = await invoke([family, "get", "record/with?#"], response());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.requests[0].url,
      `http://localhost:8787/v1/payments/${family}/record%2Fwith%3F%23`
    );
  }
});

test("complete request bodies support inline JSON, files and stdin without changing integer strings or nulls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-recurring-"));
  try {
    const payload = {
      subscriberTokenAccount: SOL_MINT,
      expectedPlanCreatedAt: "18446744073709551615",
      expectedSubscriptionAuthorityInitId: "-9223372036854775808",
    };
    const text = JSON.stringify(payload),
      file = path.join(directory, "authorization.json");
    await writeFile(file, text);
    for (const source of [text, `@${file}`, "-"]) {
      const result = await invoke(
        [
          "subscriptions",
          "authorize",
          "build-unsigned-transaction",
          subscription.id,
          "--data",
          source,
        ],
        Response.json({
          data: {
            subscription,
            subscriptionPda: SOL_MINT,
            subscriptionAuthorityAddress: SOL_MINT,
            preparedTransaction,
          },
          meta,
        }),
        { stdin: text }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), payload);
    }
    const nullable = { nextCollectionDueAt: null, metadataUri: null };
    const result = await invoke(
      [
        "recurring-payments",
        "update",
        recurring.id,
        "--data",
        JSON.stringify(nullable),
        "--idempotency-key",
        "edit-1",
      ],
      recurringResponse()
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), nullable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid terms, empty edits, conflicting clears and unsupported preparation fields stop locally", async () => {
  const cases = [
    [
      "recurring-payments",
      "create",
      ...recurringArgs,
      "--period-hours",
      "0",
      "--idempotency-key",
      "x",
    ],
    [
      "recurring-payments",
      "create",
      ...recurringArgs,
      "--period-hours",
      "8761",
      "--idempotency-key",
      "x",
    ],
    [
      "recurring-payments",
      "create",
      ...recurringArgs,
      "--period-hours",
      "1.5",
      "--idempotency-key",
      "x",
    ],
    ["recurring-payments", "update", recurring.id, "--idempotency-key", "x"],
    ["recurring-payments", "update", recurring.id, "--data", "{}", "--idempotency-key", "x"],
    [
      "recurring-payments",
      "update",
      recurring.id,
      "--first-collection-at",
      "2099-01-01T00:00:00Z",
      "--clear-first-collection-at",
      "--idempotency-key",
      "x",
    ],
    [
      "recurring-payments",
      "update",
      recurring.id,
      "--next-collection-due-at",
      "2099-01-01T00:00:00Z",
      "--clear-next-collection-due-at",
      "--idempotency-key",
      "x",
    ],
    [
      "recurring-payments",
      "update",
      recurring.id,
      "--metadata-uri",
      "https://example.com",
      "--clear-metadata-uri",
      "--idempotency-key",
      "x",
    ],
    [
      "recurring-payments",
      "update",
      recurring.id,
      "--data",
      '{"status":"active"}',
      "--idempotency-key",
      "x",
    ],
    ["subscription-plans", "update", plan.id],
    ["subscription-plans", "update", plan.id, "--amount", "30"],
    ["subscription-plans", "update", plan.id, "--plan-pda", SOL_MINT, "--clear-plan-pda"],
    [
      "subscription-plans",
      "update",
      plan.id,
      "--metadata-uri",
      "https://example.com",
      "--clear-metadata-uri",
    ],
    ["subscription-plans", "create", "build-unsigned-transaction", plan.id, "--destinations", "{}"],
    [
      "subscription-plans",
      "create",
      "build-unsigned-transaction",
      plan.id,
      "--destinations",
      JSON.stringify(Array.from({ length: 5 }, () => SOL_MINT)),
    ],
    ["subscription-plans", "create", "build-unsigned-transaction", plan.id, "--end-ts=-1"],
    ["subscriptions", "create-record", ...subscriptionArgs, "--status", "active"],
    [
      "subscriptions",
      "create-record",
      "--data",
      JSON.stringify({
        planId: plan.id,
        counterpartyId: recurring.counterpartyId,
        subscriberAddress: SOL_MINT,
        authorizationSignature: "unverified",
      }),
    ],
    [
      "subscriptions",
      "authorize",
      "build-unsigned-transaction",
      subscription.id,
      "--subscriber-token-account",
      SOL_MINT,
    ],
    [
      "subscriptions",
      "authorize",
      "build-unsigned-transaction",
      subscription.id,
      "--subscriber-token-account",
      SOL_MINT,
      "--expected-plan-created-at",
      "1e10",
      "--expected-subscription-authority-init-id",
      "0",
    ],
    [
      "subscriptions",
      "collect",
      "build-unsigned-transaction",
      subscription.id,
      "--receiver-token-account",
      SOL_MINT,
      "--amount",
      "100",
    ],
    [
      "subscriptions",
      "cancel",
      "build-unsigned-transaction",
      subscription.id,
      "--data",
      '{"force":true}',
    ],
    [
      "subscriptions",
      "resume",
      "build-unsigned-transaction",
      subscription.id,
      "--idempotency-key",
      "unsupported",
    ],
    ["subscriptions", "list", "--status", "draft"],
    ["subscriptions", "list", "--due-before", "invalid"],
    ["subscriptions", "collection-attempts", "list", subscription.id, "--status", "active"],
    ["recurring-payments", "list", "--page-size", "101"],
    ["subscription-plans", "get", ".."],
  ];
  for (const args of cases) {
    const result = await invoke(args, recurringResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("conflicts, lost admission, uncertain submission and recovery errors do not replay money operations", async () => {
  const args = ["recurring-payments", "collect", recurring.id, "--idempotency-key", "collect-1"];
  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "IDEMPOTENCY_KEY_IN_FLIGHT"],
    [422, "IDEMPOTENCY_KEY_REUSED"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    const result = await invoke(
      args,
      Response.json({ error: { code, message: "Collection not confirmed" }, meta }, { status })
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(headers(result.requests[0]).get("idempotency-key"), "collect-1");
    assert.equal(JSON.parse(result.stderr).error.status, status);
  }
  const timeout = await invoke(args, recurringResponse(), {
    failure: new DOMException("private signing details", "TimeoutError"),
  });
  assert.equal(timeout.code, 1);
  assert.equal(timeout.requests.length, 1);
  assert(!timeout.stderr.includes("private signing"));
});

test("malformed schedule and prepared-transaction replies never produce partial output", async () => {
  for (const [args, data] of [
    [["recurring-payments", "get", recurring.id], { recurringPayment: { id: recurring.id } }],
    [
      ["subscriptions", "cancel", "build-unsigned-transaction", subscription.id],
      { subscription, preparedTransaction: { ...preparedTransaction, requiredSigners: null } },
    ],
    [
      ["subscription-plans", "create", "build-unsigned-transaction", plan.id],
      { subscriptionPlan: plan, planPda: SOL_MINT },
    ],
  ] as const) {
    const result = await invoke([...args], Response.json({ data, meta }));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert.equal(result.stdout, "");
  }
});
