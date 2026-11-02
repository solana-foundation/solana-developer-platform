import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { COMPLIANCE_PROVIDERS, EARN_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { operationById } from "./contract";
import { runCli } from "./run";

const organization = {
  id: "org_example",
  name: "Example",
  slug: "example",
  tier: "enterprise",
  status: "active",
  settings: {
    defaultEnvironment: "sandbox",
    allowedIpAddresses: ["203.0.113.0/24"],
    enableProductionProject: true,
    legacyAllowedIpAddresses: null,
    providerOverrides: { custody: { privy: true }, ramps: { moonpay: false } },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const meta = { requestId: "req_organizations", timestamp: "2026-01-01T00:00:00.000Z" };
const session = { SDP_TOKEN: "org-test-session", SDP_API_URL: "http://localhost:8787" };

interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  response: Response,
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}
) {
  let stdout = "";
  let stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? session,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
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

function organizationResponse(): Response {
  return Response.json({ data: organization, meta });
}
function createResponse(): Response {
  return Response.json(
    { data: { organization, clerkOrganizationId: "org_clerk_example" }, meta },
    { status: 201 }
  );
}

test("organization help describes signup, IDs, and mainnet access without authentication", async () => {
  for (const args of [
    ["organizations"],
    ["organizations", "create", "--help"],
    ["organizations", "get", "--help"],
    ["organizations", "mainnet-access", "get", "--help"],
    ["organizations", "provider-availability", "get", "--help"],
  ]) {
    const result = await invoke(args, organizationResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("organizations"));
    if (args[1] === "create") {
      assert(result.stdout.includes("no active organization"));
      assert(!result.stdout.includes("Requires action:"));
    }
    if (args[1] === "get") assert(result.stdout.includes("[orgId]"));
  }
});

test("reads an organization with an API key and preserves its complete settings", async () => {
  const result = await invoke(["organizations", "get", organization.id], organizationResponse(), {
    env: { SDP_API_KEY: "org-test-key" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    `https://api.solana.com/v1/organizations/${organization.id}`
  );
  assert.equal(
    new Headers(result.requests[0].init.headers).get("authorization"),
    "Bearer org-test-key"
  );
  assert.deepEqual(JSON.parse(result.stdout), { data: organization, meta });
});

test("organization selection uses positional ID, flag, then environment", async () => {
  for (const [args, id] of [
    [["organizations", "get"], "org_env"],
    [["organizations", "get", "--organization", "org_flag"], "org_flag"],
    [["organizations", "get", "org_argument", "--organization", "org_flag"], "org_argument"],
  ] as const) {
    const result = await invoke([...args], organizationResponse(), {
      env: { ...session, SDP_ORGANIZATION_ID: "org_env", SDP_PROJECT_ID: "prj_default" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].url, `http://localhost:8787/v1/organizations/${id}`);
  }
});

test("organization IDs are encoded as one path segment", async () => {
  const result = await invoke(["organizations", "get", "org_/with?#"], organizationResponse());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/organizations/org_%2Fwith%3F%23");
});

test("creates an organization with a signup session without sending a default project header", async () => {
  const result = await invoke(["organizations", "create", "--name", "Example"], createResponse(), {
    env: { ...session, SDP_PROJECT_ID: "prj_existing", SDP_ORGANIZATION_ID: "org_existing" },
  });
  assert.equal(result.code, 0, result.stderr);
  const request = result.requests[0];
  assert.equal(request.url, "http://localhost:8787/v1/organizations");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { name: "Example" });
  assert.equal(new Headers(request.init.headers).get("x-project-id"), null);
  assert.equal(JSON.parse(result.stdout).data.clerkOrganizationId, "org_clerk_example");
  assert.equal(result.requests.length, 1);
  assert.equal(operationById("createOrganization").authorization.kind, "signup");
});

test("creation supports inline JSON, files and stdin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-org-"));
  try {
    const file = path.join(directory, "organization.json");
    const body = JSON.stringify({ name: "Example" });
    await writeFile(file, body);
    for (const data of [body, `@${file}`, "-"]) {
      const result = await invoke(["organizations", "create", "--data", data], createResponse(), {
        stdin: body,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { name: "Example" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates an organization name and settings with repeatable allowlist flags", async () => {
  const result = await invoke(
    [
      "organizations",
      "update",
      organization.id,
      "--name",
      "Updated",
      "--default-environment",
      "production",
      "--allowed-ip",
      "203.0.113.0/24",
      "--allowed-ip",
      "2001:db8::/32",
    ],
    organizationResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    name: "Updated",
    settings: {
      defaultEnvironment: "production",
      allowedIpAddresses: ["203.0.113.0/24", "2001:db8::/32"],
    },
  });
});

test("clear-allowed-ips sends an explicit empty array without changing other settings", async () => {
  const result = await invoke(
    ["organizations", "update", organization.id, "--clear-allowed-ips"],
    organizationResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    settings: { allowedIpAddresses: [] },
  });
});

test("updates settings using JSON or a complete body", async () => {
  const settings = { defaultEnvironment: "production", allowedIpAddresses: [] };
  for (const args of [
    ["--settings", JSON.stringify(settings)],
    ["--data", JSON.stringify({ settings })],
    ["--data", "-"],
  ]) {
    const result = await invoke(
      ["organizations", "update", organization.id, ...args],
      organizationResponse(),
      { stdin: JSON.stringify({ settings }) }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { settings });
  }
});

test("the removed organization delete command is refused without a request", async () => {
  const result = await invoke(["organizations", "delete", organization.id], organizationResponse());
  assert.equal(result.code, 2);
  assert.equal(result.requests.length, 0);
});

test("provider access preserves the internal provider view and allows an API key", async () => {
  const entries = (providers: readonly string[]) =>
    Object.fromEntries(
      providers.map((provider) => [provider, { entitled: true, configured: false, enabled: false }])
    );
  const data = {
    tier: "enterprise",
    providers: {
      custody: entries(CUSTODY_PROVIDERS),
      compliance: entries(COMPLIANCE_PROVIDERS),
      ramps: entries(RAMP_PROVIDERS),
      earn: entries(EARN_PROVIDERS),
    },
  };
  const result = await invoke(
    ["organizations", "provider-availability", "get", organization.id],
    Response.json({ data, meta }),
    { env: { SDP_API_KEY: "org-test-key" } }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    `https://api.solana.com/v1/organizations/${organization.id}/provider-availability`
  );
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
});

test("API keys are refused organization creation, updates and mainnet administration before any request", async () => {
  for (const args of [
    ["organizations", "create", "--name", "Example"],
    ["organizations", "update", organization.id, "--name", "Updated"],
    ["organizations", "mainnet-access", "get", organization.id],
  ]) {
    const result = await invoke(args, organizationResponse(), {
      env: { SDP_API_KEY: "org-test-key" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Clerk session"));
  }
});

test("invalid organization usage and payloads fail without sending requests", async () => {
  const cases = [
    ["organizations", "list"],
    ["organizations", "get"],
    ["organizations", "get", ".."],
    ["organizations", "create", organization.id, "--name", "Example"],
    ["organizations", "create"],
    ["organizations", "create", "--name", ""],
    ["organizations", "create", "--data", '{"name":"Example","tier":"enterprise"}'],
    ["organizations", "create", "--name", "Example", "--data", '{"name":"Another"}'],
    ["organizations", "update", organization.id],
    ["organizations", "update", organization.id, "--data", "{}"],
    ["organizations", "update", organization.id, "--data", '{"settings":null}'],
    ["organizations", "update", organization.id, "--data", '{"name":null}'],
    [
      "organizations",
      "update",
      organization.id,
      "--data",
      '{"settings":{"enableProductionProject":true}}',
    ],
    [
      "organizations",
      "update",
      organization.id,
      "--data",
      '{"settings":{"allowedIpAddresses":[1]}}',
    ],
    ["organizations", "update", organization.id, "--default-environment", "devnet"],
    ["organizations", "update", organization.id, "--settings", "null"],
    [
      "organizations",
      "update",
      organization.id,
      "--settings",
      "{}",
      "--default-environment",
      "sandbox",
    ],
    [
      "organizations",
      "update",
      organization.id,
      "--clear-allowed-ips",
      "--allowed-ip",
      "203.0.113.1",
    ],
    ["organizations", "update", organization.id, "--clear-description"],
    ["organizations", "delete", organization.id, "--data", "{}"],
    ["organizations", "delete", organization.id, "--idempotency-key", "unsupported"],
  ];
  for (const args of cases) {
    const result = await invoke(args, organizationResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 0);
  }
});

test("creation conflicts preserve request details and make no automatic retry", async () => {
  const result = await invoke(
    ["organizations", "create", "--name", "Another"],
    Response.json(
      { error: { code: "CONFLICT", message: "You have already created an organization" }, meta },
      { status: 409 }
    )
  );
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.requestId, meta.requestId);
  assert.equal(result.requests.length, 1);
});

test("unexpected no-content organization reads remain failures", async () => {
  const unexpected = await invoke(
    ["organizations", "get", organization.id],
    new Response(null, { status: 204 })
  );
  assert.equal(unexpected.code, 1);
  assert.equal(JSON.parse(unexpected.stderr).error.code, "INVALID_RESPONSE");
});

const mainnetAccess = {
  state: "pending",
  available: true,
  countryCode: "US",
  request: {
    requestedAt: meta.timestamp,
    requestedByUserId: "usr_example",
    termsVersion: "reviewed-terms-version",
    notified: false,
  },
  contactEmail: "access@example.test",
};

test("mainnet access reads and notification retries require a session without a project", async () => {
  for (const [verb, method, suffix] of [
    ["get", "GET", ""],
    ["notify", "POST", "/notify"],
  ]) {
    const result = await invoke(
      ["organizations", "mainnet-access", verb, "org/with space"],
      Response.json({ data: mainnetAccess, meta }),
      { env: { ...session, SDP_PROJECT_ID: "ignored_project" } }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, mainnetAccess);
    assert.equal(result.requests.length, 1);
    const request = result.requests[0];
    assert.equal(
      request.url,
      `http://localhost:8787/v1/organizations/org%2Fwith%20space/mainnet-access${suffix}`
    );
    assert.equal(request.init.method, method);
    assert.equal(request.init.body, undefined);
    assert.equal(new Headers(request.init.headers).get("x-project-id"), null);
  }
});

test("mainnet access requests send only explicitly accepted terms and never notify automatically", async () => {
  const body = {
    countryCode: "US",
    termsVersion: mainnetAccess.request.termsVersion,
    acceptTerms: true,
  };
  for (const flags of [
    ["--country-code", "US", "--terms-version", body.termsVersion, "--accept-terms", "true"],
    ["--data", JSON.stringify(body)],
  ]) {
    const result = await invoke(
      ["organizations", "mainnet-access", "request", organization.id, ...flags],
      Response.json({ data: mainnetAccess, meta }, { status: 201 })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), body);
    assert.equal(JSON.parse(result.stdout).data.request.notified, false);
  }
});

test("mainnet consent and session administration fail locally when incomplete or unsupported", async () => {
  const prefix = ["organizations", "mainnet-access", "request", organization.id];
  for (const args of [
    [...prefix, "--country-code", "US", "--terms-version", "reviewed"],
    [...prefix, "--country-code", "US", "--terms-version", "reviewed", "--accept-terms", "false"],
    [...prefix, "--data", '{"countryCode":"US","termsVersion":"reviewed"}'],
    [
      ...prefix,
      "--data",
      '{"countryCode":"US","termsVersion":"reviewed","acceptTerms":true}',
      "--idempotency-key",
      "unsupported",
    ],
    ["organizations", "mainnet-access", "notify", organization.id, "--data", "{}"],
  ]) {
    const result = await invoke(args, organizationResponse());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  for (const verb of ["get", "request", "notify"]) {
    const result = await invoke(
      ["organizations", "mainnet-access", verb, organization.id],
      organizationResponse(),
      { env: { SDP_API_KEY: "fixture-key" } }
    );
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Clerk session"));
  }
});
