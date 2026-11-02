import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commands } from "./commands";
import { operations } from "./contract";
import { runCli } from "./run";

const project = {
  id: "prj_example",
  organizationId: "org_example",
  name: "Payments",
  slug: "payments",
  description: null,
  environment: "sandbox",
  settings: null,
  status: "active",
  createdBy: "usr_example",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const meta = { requestId: "req_example", timestamp: "2026-01-01T00:00:00.000Z" };
const keyResponse = {
  apiKey: {
    id: "key_example",
    name: "Automation",
    key: "once-only-secret",
    keyPrefix: "sf_example",
    grants: ["projects.read"],
    environment: "sandbox",
    expiresAt: null,
    createdAt: project.createdAt,
  },
};

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

async function invoke(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    response?: Response;
    fetcher?: typeof fetch;
    stdin?: string;
  } = {}
) {
  let stdout = "";
  let stderr = "";
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert(init);
    requests.push({ url: String(input), init });
    if (options.fetcher) return options.fetcher(input, init);
    if (options.response) return options.response;
    return Response.json({ data: { project }, meta });
  };
  const code = await runCli(args, {
    env: options.env ?? { SDP_TOKEN: "test-credential", SDP_API_URL: "http://localhost:8787" },
    fetcher,
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

function headers(request: RecordedRequest): Headers {
  return new Headers(request.init.headers);
}

// Every generated operation must have exactly one command.
test("covers the entire CLI contract with unique command names", () => {
  assert.deepEqual(
    commands.map((command) => command.operationId).sort(),
    operations.map((operation) => operation.operationId).sort()
  );
  assert.equal(new Set(commands.map((command) => command.words.join(" "))).size, commands.length);
});

test("help and version work without authentication or network access", async () => {
  for (const args of [
    [],
    ["--help"],
    ["projects"],
    ["projects", "api-keys"],
    ["projects", "update", "--help"],
    ["--version"],
  ]) {
    const result = await invoke(args, { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert(result.stdout.length > 0);
    assert.equal(result.requests.length, 0);
  }
});

test("lists projects with query, bearer auth and complete JSON envelope", async () => {
  const response = { data: { projects: [project] }, meta };
  const result = await invoke(["--compact", "projects", "list", "--include-archived"], {
    response: Response.json(response),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${JSON.stringify(response)}\n`);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/projects?includeArchived=true");
  assert.equal(headers(result.requests[0]).get("authorization"), "Bearer test-credential");
  assert.equal(result.requests[0].init.method, "GET");
  assert.equal(result.requests[0].init.body, undefined);
  assert.equal(result.requests[0].init.redirect, "error");
});

test("gets a project, preserving base paths and encoding IDs as one path segment", async () => {
  const result = await invoke([
    "projects",
    "get",
    "prj_/with?#",
    "--api-url",
    "https://example.com/proxy/",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "https://example.com/proxy/v1/projects/prj_%2Fwith%3F%23");
});

test("project selection uses positional, flag, then environment precedence", async () => {
  const env = { SDP_API_KEY: "test-credential", SDP_PROJECT_ID: "prj_env" };
  for (const [args, id] of [
    [["projects", "get"], "prj_env"],
    [["projects", "get", "--project", "prj_flag"], "prj_flag"],
    [["projects", "get", "prj_arg", "--project", "prj_flag"], "prj_arg"],
  ] as const) {
    const result = await invoke([...args], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].url, `https://api.solana.com/v1/projects/${id}`);
  }
});

test("updates fields and supports null-clearing without inventing fields", async () => {
  const result = await invoke([
    "projects",
    "update",
    "prj_example",
    "--name",
    "New name",
    "--clear-description",
    "--clear-settings",
    "--idempotency-key",
    "update-1",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    name: "New name",
    description: null,
    settings: null,
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), "update-1");
});

test("accepts nested settings as flags and JSON body from stdin or file", async () => {
  const body = {
    settings: { webhookUrl: "https://example.com/webhook", metadata: { region: "US" } },
  };
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-"));
  try {
    const file = path.join(directory, "body.json");
    await writeFile(file, JSON.stringify(body));
    const variants = [
      ["--settings", JSON.stringify(body.settings)],
      ["--data", JSON.stringify(body)],
      ["--data", "-"],
      ["--data", `@${file}`],
    ];
    for (const flags of variants) {
      const result = await invoke(["projects", "update", "prj_example", ...flags], {
        stdin: JSON.stringify(body),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), body);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requests provider availability from the project subresource", async () => {
  const response = {
    data: {
      projectId: project.id,
      environment: "sandbox",
      providers: [
        {
          family: "custody",
          provider: "privy",
          modes: ["byok"],
          unavailableModes: [{ mode: "managed", reason: "custody_mode_not_allowed" }],
        },
        { family: "compliance", provider: "range", available: true },
        { family: "ramps", provider: "moonpay", available: false, reason: "provider_not_entitled" },
      ],
    },
    meta,
  };
  const result = await invoke(["projects", "provider-availability", "get", project.id], {
    response: Response.json(response),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    `http://localhost:8787/v1/projects/${project.id}/provider-availability`
  );
});

test("member and API-key lists use a session token", async () => {
  for (const [resource, data] of [
    ["members", { members: [] }],
    ["api-keys", { apiKeys: [] }],
  ] as const) {
    const result = await invoke(["projects", resource, "list", project.id], {
      env: { SDP_TOKEN: "session-token", SDP_PROJECT_ID: project.id },
      response: Response.json({ data, meta }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(headers(result.requests[0]).get("authorization"), "Bearer session-token");
    assert.equal(headers(result.requests[0]).get("x-project-id"), project.id);
    assert.equal(
      new URL(result.requests[0].url).pathname,
      `/v1/projects/${project.id}/${resource}`
    );
  }
});

test("creates a project API key with explicit grants and wallet scope, returning its secret once", async () => {
  const result = await invoke(
    [
      "projects",
      "api-keys",
      "create",
      project.id,
      "--name",
      "Automation",
      "--grant",
      "projects.read",
      "--grant",
      "wallets.read",
      "--wallet-scope",
      "selected",
      "--wallet-id",
      "cwlt_example",
      "--allowed-ip",
      "203.0.113.1",
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
    ],
    {
      env: { SDP_TOKEN: "session-token" },
      response: Response.json({ data: keyResponse, meta }, { status: 201 }),
    }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    name: "Automation",
    grants: ["projects.read", "wallets.read"],
    walletScope: "selected",
    walletIds: ["cwlt_example"],
    allowedIps: ["203.0.113.1"],
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(JSON.parse(result.stdout).data.apiKey.key, "once-only-secret");
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
});

test("explicit auth flags override environment credentials", async () => {
  const result = await invoke(["projects", "get", project.id, "--token", "explicit-session"], {
    env: { SDP_API_KEY: "env-key", SDP_TOKEN: "env-session" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(headers(result.requests[0]).get("authorization"), "Bearer explicit-session");
});

test("usage and validation failures never send requests", async () => {
  const cases = [
    ["projects", "create"],
    ["projects", "get"],
    ["projects", "get", ".."],
    ["projects", "get", project.id, "extra"],
    ["projects", "list", "--name", "ignored"],
    ["projects", "list", "--bogus"],
    ["projects", "get", project.id, "--timeout-ms", "0"],
    ["projects", "get", project.id, "--api-url", "http://example.com"],
    ["projects", "get", project.id, "--api-url", "https://user:password@example.com"],
    ["projects", "update", project.id],
    ["projects", "update", project.id, "--data", "{}"],
    ["projects", "update", project.id, "--data", "[]"],
    ["projects", "update", project.id, "--data", "not-json"],
    ["projects", "update", project.id, "--data", '{"naem":"typo"}'],
    ["projects", "update", project.id, "--data", '{"name":null}'],
    ["projects", "update", project.id, "--name", ""],
    ["projects", "update", project.id, "--settings", '{"webhookUrl":"invalid"}'],
    ["projects", "update", project.id, "--name", "test", "--data", '{"description":null}'],
    ["projects", "update", project.id, "--description", "test", "--clear-description"],
    ["projects", "update", project.id, "--settings", "{}", "--clear-settings"],
  ];
  for (const args of cases) {
    const result = await invoke(args);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("missing, ambiguous, or malformed credentials fail without leaking values", async () => {
  for (const env of [
    {},
    { SDP_API_KEY: "secret-key", SDP_TOKEN: "secret-token" },
    { SDP_API_KEY: "secret key" },
  ]) {
    const result = await invoke(["projects", "get", project.id], { env });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
    assert(!result.stderr.includes("secret"));
  }
});

test("API errors preserve status, code and request ID on stderr only", async () => {
  for (const status of [401, 403, 404, 409, 429, 500, 503]) {
    const result = await invoke(["projects", "get", project.id], {
      response: Response.json(
        {
          error: { code: "REFUSED", message: "Request refused" },
          meta: { requestId: "req_error" },
        },
        { status }
      ),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: { code: "REFUSED", message: "Request refused", status, requestId: "req_error" },
    });
    assert.equal(result.requests.length, 1);
  }
});

test("HTTP errors redact an echoed credential", async () => {
  const result = await invoke(["projects", "get", project.id], {
    response: Response.json(
      { error: { code: "DENIED", message: "Denied test-credential" } },
      { status: 403 }
    ),
  });
  assert.equal(result.code, 1);
  assert(!result.stderr.includes("test-credential"));
});

test("malformed JSON, invalid response schemas and unexpected statuses fail cleanly", async () => {
  for (const response of [
    new Response("<html>upstream down</html>", { status: 502 }),
    Response.json({ data: {} }),
    Response.json({ data: { project }, meta }, { status: 202 }),
  ]) {
    const result = await invoke(["projects", "get", project.id], { response });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});

test("network and timeout failures have stable errors and never retry a key creation", async () => {
  for (const name of ["Error", "TimeoutError"]) {
    const fetcher: typeof fetch = async () => {
      throw new DOMException("sensitive upstream details", name);
    };
    const result = await invoke(
      [
        "projects",
        "api-keys",
        "create",
        project.id,
        "--data",
        '{"name":"Key","grants":[],"walletScope":"selected"}',
      ],
      { env: { SDP_TOKEN: "session-token" }, fetcher }
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"
    );
    assert.equal(result.requests.length, 1);
    assert(!result.stderr.includes("sensitive"));
  }
});

test("API keys cannot run project, member or key administration", async () => {
  for (const args of [
    ["projects", "update", project.id, "--name", "Updated"],
    ["projects", "members", "list", project.id],
    ["projects", "api-keys", "list", project.id],
    [
      "projects",
      "api-keys",
      "create",
      project.id,
      "--data",
      '{"name":"Key","grants":[],"walletScope":"selected"}',
    ],
  ]) {
    const result = await invoke(args, { env: { SDP_API_KEY: "test-key" } });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Clerk session"));
  }
});

test("a positional project also overrides the session project header", async () => {
  const result = await invoke(["projects", "get", "prj_positional"], {
    env: { SDP_TOKEN: "session-token", SDP_PROJECT_ID: "prj_default" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(headers(result.requests[0]).get("x-project-id"), "prj_positional");
});
