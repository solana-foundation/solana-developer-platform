import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { type Json, operationById } from "./contract";
import { runCli } from "./run";
import { webhookCommands } from "./webhook-input";

const meta = { requestId: "req_webhook", timestamp: "2026-10-29T00:00:00.000Z" };
const payload = Buffer.from(
  '{\r\n "id":"evt_example", "text":"é🙂", "value":1e2, "value":2\r\n}\n'
);
const digest = "test-digest-for-captured-delivery/+?=$";
const clerk = {
  "svix-id": "msg_captured",
  "svix-timestamp": "1234567890",
  "svix-signature": `v1,${digest}`,
};
const stripe = { "stripe-signature": `t=1234567890,v1=old-digest,v1=${digest}` };
const moonpay = { "moonpay-signature-v2": `t=1234567890,s=${digest}` };
function signature(provider: string) {
  return provider === "stripe" ? stripe : moonpay;
}
function receipt(args: string[]) {
  return args[1] === "clerk"
    ? { received: true }
    : { received: true, provider: args[4], environment: args[2] };
}
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  options: {
    stdin?: string | Uint8Array;
    env?: NodeJS.ProcessEnv;
    reply?: Response;
  } = {}
) {
  let stdout = "",
    stderr = "",
    stdinReads = 0;
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? { SDP_API_URL: "http://localhost:8787" },
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return options.reply ?? Response.json({ data: receipt(args), meta });
    },
    readStdin: async () => {
      stdinReads += 1;
      return options.stdin ?? payload;
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests, stdinReads };
}
const clerkArgs = ["webhooks", "clerk", "deliver"];
const delivery = (args: string[], headers: Record<string, string>) => [
  ...args,
  "--body",
  "-",
  "--headers",
  JSON.stringify(headers),
];
function bytes(request: RecordedRequest) {
  assert(request.init.body instanceof Uint8Array);
  return Buffer.from(request.init.body);
}

test("all three webhook commands expose offline help and signature-authenticated raw contracts", async () => {
  assert.equal(webhookCommands.length, 3);
  for (const command of webhookCommands) {
    const result = await invoke([...command.words, "--help"], { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert.equal(result.stdinReads, 0);
    assert(result.stdout.includes("signature"));
    assert(result.stdout.includes("--body"));
    const operation = operationById(command.operationId);
    assert.equal(operation.authorization.kind, "webhook");
    assert.equal(operation.sessionOnly, false);
    assert.equal(operation.body, null);
    assert.deepEqual(operation.rawBody, { contentType: "application/json", maxBytes: 1024 * 1024 });
    assert(
      !operation.parameters.some((parameter) => parameter.name.toLowerCase() === "x-project-id")
    );
  }
  const parent = await invoke(["webhooks", "--help"], { env: {} });
  assert.equal(parent.code, 0, parent.stderr);
});
test("Clerk delivery sends unchanged bytes and all Svix headers without account or tenant credentials", async () => {
  const result = await invoke(delivery(clerkArgs, clerk), {
    env: {
      SDP_API_URL: "http://localhost:8787",
      SDP_API_KEY: "invalid ignored key",
      SDP_TOKEN: "invalid ignored token",
      SDP_PROJECT_ID: "",
      SDP_ORGANIZATION_ID: "",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.stdinReads, 1);
  const request = result.requests[0],
    headers = new Headers(request.init.headers);
  assert.equal(request.url, "http://localhost:8787/webhooks/clerk");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.deepEqual(bytes(request), payload);
  for (const [name, value] of Object.entries(clerk)) assert.equal(headers.get(name), value);
  for (const name of ["authorization", "x-project-id", "x-organization-id", "idempotency-key"])
    assert.equal(headers.get(name), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(result.stdout), { data: { received: true }, meta });
});
test("both explicit ramp environments and every provider preserve signed headers and acknowledgement", async () => {
  for (const environment of ["sandbox", "production"])
    for (const provider of RAMP_PROVIDERS) {
      const args = ["webhooks", "ramps", environment, "deliver", provider];
      const result = await invoke(delivery(args, signature(provider)));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.requests.length, 1);
      const request = result.requests[0];
      assert.equal(
        request.url,
        `http://localhost:8787/webhooks/payments/ramps/${environment}/${provider}`
      );
      assert.deepEqual(bytes(request), payload);
      for (const [name, value] of Object.entries(signature(provider)))
        assert.equal(new Headers(request.init.headers).get(name), value);
      assert.deepEqual(JSON.parse(result.stdout).data, receipt(args));
      assert(!result.stdout.includes("completed"));
    }
});
test("body files and header files or stdin preserve binary input and case-insensitive header names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-webhook-input-"));
  try {
    const bodyFile = path.join(directory, "event.json"),
      headersFile = path.join(directory, "headers.json");
    const original = Buffer.concat([payload, Buffer.from([0, 255, 254])]);
    await writeFile(bodyFile, original);
    const mixed = {
      "Svix-Id": clerk["svix-id"],
      "Svix-Timestamp": clerk["svix-timestamp"],
      "Svix-Signature": clerk["svix-signature"],
    };
    await writeFile(headersFile, JSON.stringify(mixed));
    for (const source of [`@${headersFile}`, "-"]) {
      const result = await invoke([...clerkArgs, "--body", `@${bodyFile}`, "--headers", source], {
        stdin: Buffer.from(JSON.stringify(mixed)),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(bytes(result.requests[0]), original);
      assert.equal(
        new Headers(result.requests[0].init.headers).get("svix-signature"),
        clerk["svix-signature"]
      );
      assert.equal(result.stdinReads, source === "-" ? 1 : 0);
    }
    const invalid = await invoke([...clerkArgs, "--body", `@${bodyFile}`, "--headers", "-"], {
      stdin: Buffer.from([255]),
    });
    assert.equal(invalid.code, 2);
    assert.equal(invalid.requests.length, 0);
    assert(invalid.stderr.includes("Webhook headers must be UTF-8 JSON"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("body size is bounded in bytes, and the exact 1 MiB limit is accepted", async () => {
  for (const [stdin, expected] of [
    [Buffer.alloc(1024 * 1024, 32), 0],
    [Buffer.alloc(1024 * 1024 + 1, 32), 2],
    ["é".repeat(524289), 2],
    [Buffer.alloc(0), 2],
  ] as const) {
    const result = await invoke(delivery(clerkArgs, clerk), { stdin });
    assert.equal(result.code, expected, result.stderr);
    assert.equal(result.requests.length, expected === 0 ? 1 : 0);
  }
});
test("missing inputs, invalid files and competing stdin consumers fail before fetch", async () => {
  for (const extra of [
    [],
    ["--body", "-"],
    ["--headers", JSON.stringify(clerk)],
    ["--body", "-", "--headers", "-"],
    ["--body", "{}", "--headers", JSON.stringify(clerk)],
    ["--body", "@/missing/webhook.json", "--headers", JSON.stringify(clerk)],
    ["--body", "-", "--headers", "@/missing/headers.json"],
  ]) {
    const result = await invoke([...clerkArgs, ...extra]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("header values and names are validated without echoing captured signatures", async () => {
  const badHeaders: Json[] = [
    null,
    [],
    "value",
    { "svix-signature": 3 },
    { "svix-signature": "\r\n" },
    { ...clerk, Authorization: "secret" },
    { ...clerk, Cookie: "secret" },
    { ...clerk, Host: "example.com" },
    { ...clerk, "Idempotency-Key": "secret" },
    { ...clerk, "x-project-id": "secret" },
    { ...clerk, "Svix-Signature": "duplicate" },
  ];
  for (const value of badHeaders) {
    const result = await invoke([...clerkArgs, "--body", "-", "--headers", JSON.stringify(value)]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(!result.stderr.includes(digest));
  }
});
test("each signature authentication alternative is required and empty values are refused", async () => {
  const incompleteClerk: Record<string, string>[] = [
    {},
    { "svix-signature": clerk["svix-signature"] },
    { ...clerk, "svix-id": " " },
  ];
  for (const headers of incompleteClerk) {
    const result = await invoke(delivery(clerkArgs, headers));
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
  const incompleteRamps: Record<string, string>[] = [
    {},
    { "stripe-signature": "" },
    { "svix-signature": clerk["svix-signature"] },
  ];
  for (const headers of incompleteRamps) {
    const result = await invoke(
      delivery(["webhooks", "ramps", "sandbox", "deliver", "stripe"], headers)
    );
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("unsupported providers, environments, body flags and retry keys never reach ingress", async () => {
  const base = ["webhooks", "ramps", "sandbox", "deliver", "stripe"];
  for (const args of [
    [...base, "--data", "{}"],
    [...base, "--idempotency-key", "forbidden"],
    ["webhooks", "ramps", "sandbox", "deliver", "unknown"],
    ["webhooks", "ramps", "sandbox", "deliver", "stripe/../moonpay"],
    ["webhooks", "ramps", "devnet", "stripe"],
    [...clerkArgs, "extra-id"],
  ]) {
    const result = await invoke(delivery(args, stripe));
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("signature refusals and ingress errors retain structured details with signature values redacted", async () => {
  for (const status of [400, 401, 403, 413, 429, 500, 503]) {
    const result = await invoke(
      delivery(["webhooks", "ramps", "production", "deliver", "stripe"], stripe),
      {
        reply: Response.json(
          {
            error: {
              code: "INGRESS_REFUSED",
              message: `Rejected ${stripe["stripe-signature"]}`,
              details: {
                [digest]: [digest, encodeURIComponent(digest)],
                reason: "signature_expired",
              },
            },
            meta: { requestId: digest },
          },
          { status }
        ),
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 1);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.message, "Rejected [REDACTED]");
    assert.equal(error.requestId, "[REDACTED]");
    assert.equal(error.status, status);
    assert.equal(error.details.reason, "signature_expired");
    assert(!result.stderr.includes(digest));
    assert(!result.stderr.includes(encodeURIComponent(digest)));
  }
});
test("malformed or mismatched receipt envelopes cannot imply successful delivery", async () => {
  for (const data of [
    { received: false },
    { received: true },
    { received: true, provider: "unknown", environment: "sandbox" },
    { received: true, provider: "stripe", environment: "production" },
  ]) {
    const result = await invoke(
      delivery(["webhooks", "ramps", "sandbox", "deliver", "stripe"], stripe),
      {
        reply: Response.json({ data, meta }),
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
test("ordinary JSON stdin still decodes UTF-8 bytes while malformed UTF-8 fails locally", async () => {
  const args = ["places", "autocomplete", "--data", "-"];
  const body = { input: "123 Église", sessionToken: "lookup" };
  const result = await invoke(args, {
    env: { SDP_API_KEY: "places-key" },
    stdin: Buffer.from(JSON.stringify(body)),
    reply: Response.json({ data: { suggestions: [] }, meta }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), body);
  const bad = await invoke(args, { env: { SDP_API_KEY: "places-key" }, stdin: Buffer.from([255]) });
  assert.equal(bad.code, 2);
  assert.equal(bad.requests.length, 0);
});
