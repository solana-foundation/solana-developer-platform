import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
} from "@sdp/types/private-channels";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Command } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { privateChannelsCommands } from "./private-channels-commands";
import { runCli } from "./run";

const meta = { requestId: "req_private", timestamp: "2026-10-29T00:00:00.000Z" };
const apiKey = { SDP_API_KEY: "private-channel-key", SDP_API_URL: "http://localhost:8787" };
const session = {
  SDP_TOKEN: "private-channel-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: apiKey.SDP_API_URL,
};
const amount = "9007199254740993.000001";
const configuration = {
  gatewayUrl: "https://gateway.example",
  authUrl: "https://auth.example",
  escrowProgramId: SOL_MINT,
  withdrawProgramId: SOL_MINT,
  escrowInstanceAddr: SOL_MINT,
};
const instance = {
  ...configuration,
  id: "pci_example",
  organizationId: "org_example",
  projectId: "prj_example",
  chainRpcUrl: "",
  isActive: true,
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const channel = {
  id: "pch_example",
  name: "Treasury",
  description: null,
  isDefault: false,
  status: "active",
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const principal = {
  id: "pcu_example",
  name: "Treasury desk",
  isDefault: false,
  status: "active",
  verifiedWalletCount: 0,
  createdAt: meta.timestamp,
  channels: [],
};
const wallet = {
  id: "pcvw_example",
  walletId: "cwlt_example",
  pubkey: SOL_MINT,
  verifiedAt: meta.timestamp,
};
const commonMovement = {
  id: "movement_example",
  instanceId: instance.id,
  organizationId: instance.organizationId,
  projectId: instance.projectId,
  walletId: wallet.walletId,
  mint: SOL_MINT,
  amount,
  status: "submitted",
  signature: "signature_example",
  failureReason: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const deposit = {
  ...commonMovement,
  depositor: SOL_MINT,
  recipient: SOL_MINT,
  settlementRef: null,
  context: {},
};
const withdrawal = {
  ...commonMovement,
  owner: SOL_MINT,
  destination: SOL_MINT,
  settlementRef: null,
  context: {},
};
const transfer = {
  ...commonMovement,
  channelId: channel.id,
  sender: SOL_MINT,
  recipient: SOL_MINT,
};
const membership = {
  id: "pcm_example",
  channel_id: channel.id,
  private_channel_user_id: principal.id,
  added_by: null,
  added_at: meta.timestamp,
};
const pathValues: Record<string, string> = {
  id: "record/example?#",
  channelId: "channel/example?#",
  principalId: "principal/example?#",
  walletId: "wallet/example?#",
  pubkey: SOL_MINT,
};
const movementInput = { walletId: wallet.walletId, amount };
const bodySamples: Record<string, JsonObject> = {
  connectPrivateChannelInstance: configuration,
  updatePrivateChannelInstance: { ...configuration, instanceId: instance.id },
  probePrivateChannelConnection: {
    gatewayUrl: configuration.gatewayUrl,
    authUrl: configuration.authUrl,
  },
  createPrivateChannelDeposit: movementInput,
  createPrivateChannelWithdrawal: movementInput,
  createPrivateChannelTransfer: { ...movementInput, recipientVerifiedWalletId: wallet.id },
  createPrivateChannel: { name: channel.name },
  verifyPrivateChannelWallet: {},
  createPrivateChannelPrincipal: { name: principal.name },
  addPrivateChannelPrincipalMembership: { principalId: principal.id },
};
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  reply: Response = error(),
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
      return reply;
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
function error(status = 403, code = "FORBIDDEN", details?: JsonObject) {
  return Response.json(
    {
      error: {
        code,
        message: "Private Channels operation refused",
        ...(details === undefined ? {} : { details }),
      },
      meta,
    },
    { status }
  );
}
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
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
  if (command.operationId === "getPrivateChannelHealth")
    args.push("--gateway-url", configuration.gatewayUrl);
  if (command.operationId === "getPrivateChannelBalance") args.push("--owner", wallet.walletId);
  if (op.body !== null) {
    assert(bodySamples[command.operationId], command.operationId);
    args.push("--data", JSON.stringify(bodySamples[command.operationId]));
  }
  return args;
}

test("all 35 Private Channels commands provide offline help", async () => {
  assert.equal(privateChannelsCommands.length, 35);
  for (const args of [
    ["private-channels"],
    ...privateChannelsCommands.map((command) => [...command.words, "--help"]),
  ]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("private-channels"));
  }
});
test("every Private Channels command uses the generated method, encoded path, and body", async () => {
  for (const command of privateChannelsCommands) {
    const op = operationById(command.operationId),
      result = await invoke(argsFor(command), error(), { env: session });
    assert.equal(result.code, 1, `${command.operationId}: ${result.stderr}`);
    assert.equal(result.requests.length, 1, command.operationId);
    const request = result.requests[0];
    let pathname = op.path;
    for (const parameter of op.parameters.filter((p) => p.location === "path"))
      pathname = pathname.replace(
        `{${parameter.name}}`,
        encodeURIComponent(pathValues[parameter.name])
      );
    assert.equal(new URL(request.url).pathname, pathname);
    assert.equal(request.init.method, op.method);
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      "Bearer private-channel-session"
    );
    assert.equal(new Headers(request.init.headers).get("x-project-id"), session.SDP_PROJECT_ID);
    if (op.body === null) assert.equal(request.init.body, undefined);
    else assert.deepEqual(body(request), bodySamples[command.operationId]);
  }
});
test("configure commands require a member session, and session commands require a project", async () => {
  for (const command of privateChannelsCommands) {
    const op = operationById(command.operationId);
    if (op.sessionOnly) {
      assert.deepEqual(op.authorization, { kind: "action", action: "private_channels.configure" });
      const result = await invoke(argsFor(command));
      assert.equal(result.code, 2);
      assert.equal(result.requests.length, 0);
    }
    const result = await invoke(argsFor(command), error(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("API keys can call every non-configuration route without a tenant header", async () => {
  for (const command of privateChannelsCommands) {
    if (operationById(command.operationId).sessionOnly) continue;
    const result = await invoke(argsFor(command));
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(new Headers(result.requests[0].init.headers).get("x-project-id"), null);
  }
});
test("instance connect preserves false acknowledgement and omits server defaults", async () => {
  const result = await invoke(
    [
      "private-channels",
      "instance-connection",
      "connect",
      "--gateway-url",
      configuration.gatewayUrl,
      "--auth-url",
      configuration.authUrl,
      "--escrow-program-id",
      SOL_MINT,
      "--withdraw-program-id",
      SOL_MINT,
      "--escrow-instance-addr",
      SOL_MINT,
      "--confirm-reactivate",
      "false",
    ],
    response({ instance }),
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { ...configuration, confirmReactivate: false });
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.deepEqual(JSON.parse(result.stdout), { data: { instance }, meta });
});
test("instance update pins its exact instance ID and disconnect preserves inactive state", async () => {
  const update = await invoke(
    [
      "private-channels",
      "instance-connection",
      "update",
      "--data",
      JSON.stringify({ ...configuration, instanceId: instance.id, chainRpcUrl: "" }),
    ],
    response({ instance }),
    { env: session }
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(body(update.requests[0]).instanceId, instance.id);
  const missing = await invoke(
    ["private-channels", "instance-connection", "update", "--data", JSON.stringify(configuration)],
    error(),
    { env: session }
  );
  assert.equal(missing.code, 2);
  assert.equal(missing.requests.length, 0);
  const result = await invoke(
    ["private-channels", "instance-connection", "disconnect"],
    response({ instance: { ...instance, isActive: false } }),
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.body, undefined);
  assert.equal(JSON.parse(result.stdout).data.instance.isActive, false);
});
test("instance reads preserve null and overview endpoint failures", async () => {
  const absent = await invoke(
    ["private-channels", "instance-connection", "get"],
    response({ instance: null })
  );
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).data.instance, null);
  const overview = {
    gateway: {
      health: { status: "degraded", latencyMs: 0, reason: "sequencer warming" },
      channelSlot: null,
      latestBlockhash: null,
    },
    chainRpc: { ok: false, error: "RPC unavailable" },
    escrowInstance: { present: false, error: "not found" },
    escrowProgram: { present: false, error: "not found" },
    auth: { reachable: false, error: "auth unavailable" },
  };
  const result = await invoke(
    ["private-channels", "instance", "overview", "get"],
    response({ instance, overview })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.overview, overview);
});
test("health and probe preserve negative observations as successful API responses", async () => {
  const observations: JsonObject[] = [
    { status: "ready", latencyMs: 0 },
    { status: "degraded", latencyMs: 1, reason: "warming" },
    { status: "unreachable", latencyMs: 2, error: "offline" },
  ];
  for (const health of observations) {
    const result = await invoke(
      [
        "private-channels",
        "instance-connection",
        "check-gateway-health",
        "--gateway-url",
        "https://gateway.example/a?x=1&y=2",
      ],
      response(health)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      new URL(result.requests[0].url).searchParams.get("gatewayUrl"),
      "https://gateway.example/a?x=1&y=2"
    );
    assert.deepEqual(JSON.parse(result.stdout).data, health);
  }
  const probe = {
    ok: false,
    gateway: { status: "unreachable", latencyMs: 0, error: "offline" },
    rpc: { ok: false, latencyMs: 0, error: "offline" },
    auth: { ok: false, latencyMs: 0, error: "offline" },
  };
  const result = await invoke(
    [
      "private-channels",
      "instance-connection",
      "probe",
      "--gateway-url",
      configuration.gatewayUrl,
      "--auth-url",
      configuration.authUrl,
    ],
    response(probe)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    gatewayUrl: configuration.gatewayUrl,
    authUrl: configuration.authUrl,
  });
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout).data, probe);
});
test("balance reads preserve base-unit and decimal strings without amount arithmetic", async () => {
  const balance = {
    owner: SOL_MINT,
    mint: SOL_MINT,
    tokenAccount: SOL_MINT,
    amount: "9007199254740993000001",
    decimals: 6,
    uiAmount: amount,
  };
  const result = await invoke(
    ["private-channels", "balances", "get", "--owner", wallet.walletId, "--mint", SOL_MINT],
    response(balance)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, balance);
  assert.equal(new URL(result.requests[0].url).searchParams.get("mint"), SOL_MINT);
});
test("token eligibility preserves unavailable and excluded tokens", async () => {
  const tokens = [
    {
      symbol: "FIX",
      mint: SOL_MINT,
      decimals: 6,
      tokenProgram: SOL_MINT,
      enabled: false,
      exclusionReasons: [{ code: "ALLOWLIST_UNAVAILABLE", message: "read failed" }],
    },
  ];
  const result = await invoke(
    ["private-channels", "token-eligibility", "list"],
    response({ tokens })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.tokens, tokens);
});
test("all three movement commands require an explicit idempotency key before sending", async () => {
  for (const command of privateChannelsCommands.filter(
    (command) => "idempotency-key" in command.flags
  )) {
    const args = argsFor(command),
      index = args.indexOf("--idempotency-key");
    args.splice(index, 2);
    const result = await invoke(args);
    assert.equal(result.code, 2, command.operationId);
    assert.equal(result.requests.length, 0);
  }
  assert.equal(
    privateChannelsCommands.filter((command) => "idempotency-key" in command.flags).length,
    3
  );
});
test("named movement flags preserve decimal precision, wallet identity, mint, and destinations", async () => {
  for (const [family, extra, field, reply] of [
    ["deposits", "--recipient", "recipient", deposit],
    ["withdrawals", "--destination", "destination", withdrawal],
    ["transfers", "--recipient-verified-wallet-id", "recipientVerifiedWalletId", transfer],
  ] as const) {
    const target = family === "transfers" ? wallet.id : SOL_MINT;
    const result = await invoke(
      [
        "private-channels",
        family,
        "execute",
        ...(family === "transfers" ? [channel.id] : []),
        "--wallet-id",
        wallet.walletId,
        "--amount",
        amount,
        "--mint",
        SOL_MINT,
        extra,
        target,
        "--idempotency-key",
        "same-intent-42",
      ],
      response(reply)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {
      ...movementInput,
      mint: SOL_MINT,
      [field]: target,
    });
    assert.equal(
      new Headers(result.requests[0].init.headers).get("idempotency-key"),
      "same-intent-42"
    );
    assert.equal(result.requests.length, 1);
    assert.equal(new URL(result.requests[0].url).search, "");
  }
});
test("movement requests reject numeric JSON amounts, unknown fields, and multiple source wallets", async () => {
  for (const data of [
    { walletId: wallet.walletId, amount: 1.5 },
    { ...movementInput, typo: true },
    { amount },
  ]) {
    const result = await invoke([
      "private-channels",
      "deposits",
      "execute",
      "--data",
      JSON.stringify(data),
      "--idempotency-key",
      "intent-42",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
  const result = await invoke([
    "private-channels",
    "deposits",
    "execute",
    "--wallet-id",
    "one",
    "--wallet-id",
    "two",
    "--amount",
    "1",
    "--idempotency-key",
    "intent-42",
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.requests.length, 0);
});
test("movement reads and lists preserve lifecycle, null signatures, and failure information", async () => {
  for (const [family, base, statuses] of [
    ["deposits", deposit, ["pending", "submitted", "confirmed", "settled", "failed"]],
    ["withdrawals", withdrawal, ["pending", "submitted", "confirmed", "settled", "failed"]],
    ["transfers", transfer, ["pending", "submitted", "confirmed", "failed"]],
  ] as const) {
    for (const status of statuses) {
      const value = {
        ...base,
        status,
        signature: status === "pending" ? null : base.signature,
        failureReason: status === "failed" ? "execution refused" : null,
      };
      const result = await invoke(["private-channels", family, "get", base.id], response(value));
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).data, value);
      assert.equal(result.requests.length, 1);
    }
    const result = await invoke(
      ["private-channels", family, "list"],
      response({ [family]: [base] })
    );
    assert.equal(result.code, 0, result.stderr);
  }
});
test("retained transfer history accepts one channel filter without an active-instance dependency", async () => {
  const result = await invoke(
    ["private-channels", "transfers", "list", "--channel-id", "deleted/channel?#"],
    response({ transfers: [] })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(new URL(result.requests[0].url).searchParams.get("channelId"), "deleted/channel?#");
  assert.equal(result.requests[0].init.body, undefined);
});
test("transfer recipients preserve verified-wallet IDs and project principal ownership", async () => {
  const recipients = [
    {
      id: wallet.id,
      pubkey: wallet.pubkey,
      walletName: null,
      privateChannelUserId: principal.id,
      isSelf: false,
    },
  ];
  const result = await invoke(
    ["private-channels", "channels", "transfer-recipients", "list", channel.id],
    response({ recipients })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.recipients, recipients);
});
test("events encode opaque cursors, keep exact filters, and fetch one page", async () => {
  const cursor = "opaque/+?before=#=",
    data = { events: [], hasMore: true, nextCursor: cursor };
  for (const args of [
    ["events", "list"],
    ["channels", "events", "list", channel.id],
  ]) {
    const result = await invoke(
      [
        "private-channels",
        ...args,
        "--family",
        PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
        "--type",
        PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
        "--status",
        PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
        "--limit",
        "100",
        "--before",
        cursor,
      ],
      response(data)
    );
    assert.equal(result.code, 0, result.stderr);
    const query = new URL(result.requests[0].url).searchParams;
    assert.equal(query.get("before"), cursor);
    assert.equal(query.get("limit"), "100");
    assert.equal(query.get("type"), PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
  }
});
test("invalid event enums, page limits, and repeated scalar types fail before fetch", async () => {
  for (const flags of [
    ["--family", "unknown"],
    ["--status", "unknown"],
    ["--limit", "101"],
    ["--limit", "0"],
    ["--type", "one", "--type", "two"],
  ]) {
    const result = await invoke(["private-channels", "events", "list", ...flags]);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("event references preserve the dictionary and resource IDs", async () => {
  const references = {
    [channel.id]: channel.name,
    [principal.id]: principal.name,
    [SOL_MINT]: "Fixture asset",
  };
  const result = await invoke(
    ["private-channels", "events", "reference-labels", "list"],
    response({ references })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.references, references);
});
test("channel CRUD preserves created, archived, and empty responses", async () => {
  for (const [args, reply] of [
    [["channels", "create", "--name", channel.name, "--description", ""], response(channel, 201)],
    [["channels", "list"], response({ channels: [channel] })],
    [["channels", "get", channel.id], response({ ...channel, status: "archived" })],
    [["channels", "delete", channel.id], new Response(null, { status: 204 })],
  ] as const) {
    const result = await invoke(["private-channels", ...args], reply);
    assert.equal(result.code, 0, result.stderr);
    if (reply.status === 204) assert.equal(result.stdout, "");
  }
});
test("wallet verification sends an empty object or explicit principal, and revocation uses a pubkey", async () => {
  for (const flags of [[], ["--principal-id", principal.id]]) {
    const result = await invoke(
      ["private-channels", "wallets", "verify", wallet.walletId, ...flags],
      response({ wallet })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), flags.length ? { principalId: principal.id } : {});
    assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
  }
  const listed = await invoke(
    ["private-channels", "verified-wallets", "list"],
    response({ wallets: [wallet] })
  );
  assert.equal(listed.code, 0, listed.stderr);
  const revoked = await invoke(
    ["private-channels", "verified-wallets", "revoke", SOL_MINT],
    response({ deleted: false })
  );
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal(revoked.requests[0].init.body, undefined);
});
test("principal and membership operations preserve their actual response shapes", async () => {
  const cases: [string[], JsonObject][] = [
    [["principals", "list"], { principals: [principal] }],
    [["principals", "create", "--name", principal.name], { principal }],
    [["principals", "disable", principal.id], { disabled: true }],
    [
      ["channels", "principal-memberships", "add", channel.id, "--principal-id", principal.id],
      { membership },
    ],
    [["channels", "principal-memberships", "remove", channel.id, principal.id], { removed: true }],
  ];
  for (const [args, data] of cases) {
    const result = await invoke(["private-channels", ...args], response(data), { env: session });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
  }
});
test("JSON file and stdin inputs preserve exact wire fields and conflict with body flags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sdp-private-input-"));
  try {
    const filename = path.join(dir, "deposit.json");
    await writeFile(filename, JSON.stringify(movementInput));
    for (const source of [`@${filename}`, "-"]) {
      const result = await invoke(
        [
          "private-channels",
          "deposits",
          "execute",
          "--data",
          source,
          "--idempotency-key",
          "intent-42",
        ],
        response(deposit),
        { stdin: JSON.stringify(movementInput) }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), movementInput);
    }
    const result = await invoke([
      "private-channels",
      "deposits",
      "execute",
      "--data",
      JSON.stringify(movementInput),
      "--amount",
      "2",
      "--idempotency-key",
      "intent-42",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unsupported idempotency headers and out-of-scope flags fail locally", async () => {
  for (const args of [
    ["wallets", "verify", wallet.walletId, "--idempotency-key", "intent-42"],
    ["instance-connection", "connect", "--principal-id", principal.id],
    ["deposits", "list", "--channel-id", channel.id],
    ["channels", "delete", channel.id, "--data", "{}"],
  ]) {
    const result = await invoke(["private-channels", ...args], error(), { env: session });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("reactivation, permission, and feature refusals preserve details with no retries", async () => {
  for (const [status, code, details] of [
    [409, "CONFLICT", { requiresReactivateConfirmation: true, instanceId: instance.id }],
    [403, "INSUFFICIENT_PERMISSIONS", { action: "private_channels.configure" }],
    [503, "SERVICE_UNAVAILABLE", { reason: "runtime unavailable" }],
  ] as const) {
    const result = await invoke(
      [
        "private-channels",
        "instance-connection",
        "connect",
        "--data",
        JSON.stringify(configuration),
      ],
      error(status, code, details),
      { env: session }
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stderr).error.details, details);
  }
});
test("server errors and network failures redact credentials recursively", async () => {
  const details = {
    nested: [apiKey.SDP_API_KEY, { [apiKey.SDP_API_KEY]: `upstream ${apiKey.SDP_API_KEY}` }],
  };
  const refused = await invoke(
    ["private-channels", "events", "list"],
    error(403, "FORBIDDEN", details)
  );
  assert.equal(refused.code, 1);
  assert(!refused.stderr.includes(apiKey.SDP_API_KEY));
  assert(refused.stderr.includes("[REDACTED]"));
  const failed = await invoke(
    [
      "private-channels",
      "deposits",
      "execute",
      "--data",
      JSON.stringify(movementInput),
      "--idempotency-key",
      "intent-42",
    ],
    error(),
    { failure: new Error(`connection ${apiKey.SDP_API_KEY}`) }
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.requests.length, 1);
  assert(!failed.stderr.includes(apiKey.SDP_API_KEY));
});
test("malformed success bodies and undeclared success statuses produce no stdout", async () => {
  for (const reply of [
    response({ events: [] }),
    response({ events: [], hasMore: false, nextCursor: null }, 201),
    new Response("not json", { headers: { "content-type": "application/json" } }),
  ]) {
    const result = await invoke(["private-channels", "events", "list"], reply);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
