import assert from "node:assert/strict";
import test from "node:test";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import type { OrganizationOnboardingSetup } from "@sdp/types/organizations";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { type JsonObject, operationById } from "./contract";
import { runCli } from "./run";

const timestamp = "2026-10-29T00:00:00.000Z";
const meta = { requestId: "req_balance_onboarding", timestamp };
const walletId = "provider/wallet?#";
const balance = {
  token: "SOL",
  mint: SOL_MINT,
  amount: "9007199254740993",
  uiAmount: "9007199.254740993",
  decimals: 9,
};
const balances = {
  walletBalances: {
    walletId,
    address: SOL_MINT,
    balances: [
      balance,
      { ...balance, amount: "0", uiAmount: "0", usdPrice: 0, usdValue: 0, confidential: false },
    ],
  },
};
const unlinked = { linked: false, organization: null, setup: null };
const organization = {
  id: "org_example",
  name: "Example",
  slug: "example",
  tier: "enterprise",
  status: "active",
  settings: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const setup = {
  status: "not_started",
  currentStep: "custody",
  custodyProviders: [],
  completedAt: null,
  version: 1,
  canManage: false,
} satisfies OrganizationOnboardingSetup;
const balanceArgs = ["wallets", "balances", "get", walletId];
const onboardingArgs = ["onboarding", "status", "get"];
const key = { SDP_API_KEY: "balance-key", SDP_API_URL: "http://localhost:8787" };
const session = { SDP_TOKEN: "clerk-session", SDP_API_URL: "http://localhost:8787" };
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; data?: JsonObject; reply?: Response } = {}
) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? (args[0] === "onboarding" ? session : key),
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return (
        options.reply ??
        Response.json({
          data: options.data ?? (args[0] === "onboarding" ? unlinked : balances),
          meta,
        })
      );
    },
    readStdin: async () => {
      throw new Error("Read-only commands must not consume stdin");
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}

test("balance and onboarding help is offline and declares distinct authorization", async () => {
  for (const args of [
    [...balanceArgs, "--help"],
    [...onboardingArgs, "--help"],
  ]) {
    const result = await invoke(args, { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  assert.deepEqual(operationById("getPaymentWalletBalances").authorization, {
    kind: "action",
    action: "wallets.read",
  });
  assert.equal(operationById("getPaymentWalletBalances").sessionOnly, false);
  assert.deepEqual(operationById("getOnboardingStatus").authorization, { kind: "session" });
  assert.equal(operationById("getOnboardingStatus").sessionOnly, true);
});
test("balance reads encode the provider wallet ID and preserve exact amounts, zeros and missing prices", async () => {
  const result = await invoke(balanceArgs);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0],
    headers = new Headers(request.init.headers);
  assert.equal(
    new URL(request.url).pathname,
    "/v1/payments/wallets/provider%2Fwallet%3F%23/balances"
  );
  assert.equal(new URL(request.url).search, "");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  assert.equal(headers.get("authorization"), "Bearer balance-key");
  assert.equal(headers.get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: balances, meta });
  assert(!Object.hasOwn(JSON.parse(result.stdout).data.walletBalances.balances[0], "usdPrice"));
  assert(!Object.hasOwn(JSON.parse(result.stdout).data, "balanceReadContext"));
});
test("minimum slot zero and maximum safe integer stay canonical strings on the wire", async () => {
  for (const minimumSlot of ["0", "9007199254740991"]) {
    const data = { ...balances, balanceReadContext: { minimumSlot: Number(minimumSlot) } };
    const result = await invoke([...balanceArgs, "--minimum-slot", minimumSlot], { data });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(new URL(result.requests[0].url).searchParams.get("minimumSlot"), minimumSlot);
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  }
});
test("balance sessions require a selected project while API keys remain bound to their own project", async () => {
  const missing = await invoke(balanceArgs, { env: session });
  assert.equal(missing.code, 2);
  assert.equal(missing.requests.length, 0);
  const selected = await invoke([...balanceArgs, "--project", "prj_selected"], { env: session });
  assert.equal(selected.code, 0, selected.stderr);
  assert.equal(new Headers(selected.requests[0].init.headers).get("x-project-id"), "prj_selected");
  const fixed = await invoke(balanceArgs, { env: { ...key, SDP_PROJECT_ID: "prj_ignored" } });
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(new Headers(fixed.requests[0].init.headers).get("x-project-id"), null);
});
test("noncanonical, fractional, negative and unsafe minimum slots fail before fetching balances", async () => {
  for (const slot of [
    "",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "9007199254740992",
    "18446744073709551615",
    "NaN",
  ]) {
    const result = await invoke([...balanceArgs, "--minimum-slot", slot]);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("malformed balance responses fail rather than printing partial or invented balances", async () => {
  const data: JsonObject[] = [
    { walletBalances: { walletId, balances: [] } },
    { walletBalances: { ...balances.walletBalances, balances: [{ ...balance, amount: 42 }] } },
    { ...balances, balanceReadContext: { minimumSlot: "0" } },
    { ...balances, balanceReadContext: { minimumSlot: -1 } },
    { ...balances, balanceReadContext: { minimumSlot: 9007199254740992 } },
  ];
  for (const item of data) {
    const result = await invoke(balanceArgs, { data: item });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
  const empty = { walletBalances: { ...balances.walletBalances, balances: [] } };
  const result = await invoke(balanceArgs, { data: empty });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, empty);
});
test("unavailable balance reads preserve 503 diagnostics without partial output or retry", async () => {
  const result = await invoke(balanceArgs, {
    reply: Response.json(
      {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Balance source unavailable",
          details: { provider: "rpc" },
        },
        meta,
      },
      { status: 503 }
    ),
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.requests.length, 1);
  assert.equal(JSON.parse(result.stderr).error.status, 503);
  assert.deepEqual(JSON.parse(result.stderr).error.details, { provider: "rpc" });
});
test("onboarding requires a Clerk session and refuses missing credentials or API keys locally", async () => {
  for (const env of [{}, { SDP_API_KEY: "forbidden-key" }, { SDP_TOKEN: "" }]) {
    const result = await invoke(onboardingArgs, { env });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
  const result = await invoke([...onboardingArgs, "--token", "explicit-session"], { env: key });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    new Headers(result.requests[0].init.headers).get("authorization"),
    "Bearer explicit-session"
  );
});
test("unlinked onboarding preserves explicit nulls without a project or tenant headers", async () => {
  const result = await invoke(onboardingArgs, {
    env: { ...session, SDP_PROJECT_ID: "prj_ignored", SDP_ORGANIZATION_ID: "org_ignored" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0],
    headers = new Headers(request.init.headers);
  assert.equal(request.url, "http://localhost:8787/v1/onboarding/status");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  for (const name of ["x-project-id", "x-organization-id", "content-type", "idempotency-key"])
    assert.equal(headers.get(name), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: unlinked, meta });
});
test("linked onboarding returns each setup state and server-owned management and provider values unchanged", async () => {
  const states = [
    setup,
    { ...setup, status: "in_progress", custodyProviders: [...CUSTODY_PROVIDERS], canManage: true },
    { ...setup, status: "complete", currentStep: "complete", completedAt: timestamp, version: 2 },
  ] satisfies OrganizationOnboardingSetup[];
  for (const state of states) {
    const data = { linked: true, organization, setup: state };
    const result = await invoke(onboardingArgs, { data });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  }
});
test("malformed onboarding data is not converted into an unlinked or completed state", async () => {
  const invalid: JsonObject[] = [
    {},
    { linked: "false", organization: null, setup: null },
    { linked: true, organization, setup: { ...setup, status: "unknown" } },
    { linked: true, organization, setup: { ...setup, custodyProviders: ["unknown"] } },
    { linked: true, organization, setup: { ...setup, version: 0 } },
    { linked: true, organization: { ...organization, tier: "unknown" }, setup },
  ];
  for (const data of invalid) {
    const result = await invoke(onboardingArgs, { data });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
test("onboarding admission failures remain errors with no provisioning, polling or token refresh", async () => {
  for (const status of [401, 403, 404, 500]) {
    const result = await invoke(onboardingArgs, {
      reply: Response.json(
        {
          error: {
            code: "ONBOARDING_REFUSED",
            message: `Session ${session.SDP_TOKEN} refused`,
            details: { reason: "membership_inactive" },
          },
          meta,
        },
        { status }
      ),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 1);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.status, status);
    assert.equal(error.details.reason, "membership_inactive");
    assert(!result.stderr.includes(session.SDP_TOKEN));
  }
});
test("both read-only commands reject unsupported body, replay and selector flags", async () => {
  for (const args of [
    ["wallets", "balances", "get"],
    [...balanceArgs, "--wallet-id", "another-wallet"],
    [...balanceArgs, "--data", "{}"],
    [...balanceArgs, "--idempotency-key", "key"],
    [...onboardingArgs, "--minimum-slot", "0"],
    [...onboardingArgs, "--data", "{}"],
    [...onboardingArgs, "--idempotency-key", "key"],
    [...onboardingArgs, "extra-id"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
