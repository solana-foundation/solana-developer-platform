import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type JsonObject, operationById } from "./contract";
import { placesCommands } from "./places-commands";
import { runCli } from "./run";

const meta = { requestId: "req_places", timestamp: "2026-10-29T00:00:00.000Z" };
const apiKey = { SDP_API_KEY: "places-key", SDP_API_URL: "http://localhost:8787" };
const session = { SDP_TOKEN: "places-session", SDP_API_URL: apiKey.SDP_API_URL };
const lookupToken = "lookup/session+?=#";
const input = "1600 Amphitheatre Parkway";
const suggestions: (JsonObject & { placeId: string; mainText: string })[] = [
  { placeId: "place/example?#", mainText: "Amphitheatre Parkway", secondaryText: "Mountain View" },
  { placeId: "place_second", mainText: "Another place" },
];
const place = {
  placeId: suggestions[0].placeId,
  formattedAddress: "São José, Example",
  location: { latitude: 0, longitude: 0 },
  addressFields: {
    line1: "Example street",
    line2: "",
    city: "São José",
    postalCode: "00100",
    countryCode: "BR",
    subdivisionCode: "",
  },
};
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z2sAAAAASUVORK5CYII=",
    "base64"
  )
);
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  options: {
    reply?: Response;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    failure?: Error;
    beforeReply?: () => Promise<void>;
  } = {}
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
      if (options.beforeReply) await options.beforeReply();
      return options.reply ?? response({ suggestions });
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
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function pngResponse() {
  return new Response(png, { headers: { "content-type": "image/png" } });
}
function mapArgs(output: string) {
  return [
    "places",
    "static-map",
    "download",
    "--latitude",
    "0",
    "--longitude",
    "0",
    "--output",
    output,
  ];
}

test("all Places commands provide offline help including required file output", async () => {
  assert.equal(placesCommands.length, 3);
  for (const args of [
    ["places"],
    ...placesCommands.map((command) => [...command.words, "--help"]),
  ]) {
    const result = await invoke(args, { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  const help = await invoke(["places", "static-map", "download", "--help"], { env: {} });
  assert(help.stdout.includes("counterparties.manage"));
  assert(help.stdout.includes("--output"));
  assert(!help.stdout.includes("Select a project with"));
});
test("contracts distinguish PNG from JSON and use organization-scoped manage permission", () => {
  for (const command of placesCommands) {
    const operation = operationById(command.operationId);
    assert.deepEqual(operation.authorization, { kind: "action", action: "counterparties.manage" });
    assert.equal(operation.sessionOnly, false);
    assert.equal(operation.parameters.filter((p) => p.location === "header").length, 0);
    assert.deepEqual(
      operation.binaryResponses,
      command.words[1] === "static-map" ? { "200": "image/png" } : {}
    );
  }
});
test("autocomplete preserves the explicit lookup token and makes no automatic details request", async () => {
  const result = await invoke([
    "places",
    "autocomplete",
    "--input",
    input,
    "--session-token",
    lookupToken,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0];
  assert.equal(request.url, "http://localhost:8787/v1/places/autocomplete");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(body(request), { input, sessionToken: lookupToken });
  assert.deepEqual(JSON.parse(result.stdout), { data: { suggestions }, meta });
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer places-key");
});
test("member sessions work without a project and stay separate from lookup session tokens", async () => {
  const result = await invoke(
    ["places", "autocomplete", "--input", input, "--session-token", lookupToken],
    { env: { ...session, SDP_PROJECT_ID: "ignored-project" } }
  );
  assert.equal(result.code, 0, result.stderr);
  const headers = new Headers(result.requests[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer places-session");
  assert.equal(headers.get("x-project-id"), null);
  assert.equal(body(result.requests[0]).sessionToken, lookupToken);
});
test("place details encode the place ID and billing token as separate URL components", async () => {
  const result = await invoke(
    ["places", "details", "get", place.placeId, "--session-token", lookupToken],
    {
      env: session,
      reply: response({ place }),
    }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0],
    url = new URL(request.url);
  assert.equal(url.pathname, "/v1/places/place%2Fexample%3F%23");
  assert.equal(url.searchParams.get("sessionToken"), lookupToken);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  assert.equal(new Headers(request.init.headers).get("x-project-id"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: { place }, meta });
});
test("empty suggestions and missing address components are retained without invented values", async () => {
  const empty = await invoke(
    ["places", "autocomplete", "--input", input, "--session-token", lookupToken],
    { reply: response({ suggestions: [] }) }
  );
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout).data.suggestions, []);
  const result = await invoke(
    ["places", "details", "get", place.placeId, "--session-token", lookupToken],
    {
      reply: response({ place }),
    }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.place.addressFields.line2, "");
  assert.equal(JSON.parse(result.stdout).data.place.addressFields.postalCode, "00100");
  assert.equal(JSON.parse(result.stdout).data.place.location.longitude, 0);
});
test("autocomplete supports complete inline, file, and stdin JSON bodies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-input-"));
  try {
    const data = { input, sessionToken: lookupToken },
      encoded = JSON.stringify(data),
      file = path.join(directory, "lookup.json");
    await writeFile(file, encoded);
    for (const source of [encoded, `@${file}`, "-"]) {
      const result = await invoke(["places", "autocomplete", "--data", source], { stdin: encoded });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), data);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("missing tokens, invalid lengths, wrong types, and unsupported flags fail before fetch", async () => {
  const invalid = [
    ["autocomplete", "--input", input],
    ["autocomplete", "--input", "ab", "--session-token", lookupToken],
    ["autocomplete", "--input", "x".repeat(257), "--session-token", lookupToken],
    ["autocomplete", "--input", input, "--session-token", ""],
    ["autocomplete", "--input", input, "--session-token", "x".repeat(129)],
    ["autocomplete", "--data", JSON.stringify({ input: 123, sessionToken: lookupToken })],
    ["autocomplete", "--data", JSON.stringify({ input, sessionToken: lookupToken, typo: true })],
    ["autocomplete", "--input", input, "--session-token", lookupToken, "--data", "{}"],
    ["details", "get", "place"],
    ["details", "get", "x".repeat(513), "--session-token", lookupToken],
    ["details", "get", "place", "--session-token", lookupToken, "--idempotency-key", "unsupported"],
    [
      "static-map",
      "download",
      "--latitude",
      "0",
      "--longitude",
      "0",
      "--session-token",
      lookupToken,
    ],
  ];
  for (const args of invalid) {
    const result = await invoke(["places", ...args]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("literal static-map cannot be used as a place ID", async () => {
  for (const placeId of ["static-map", ".", ".."]) {
    const result = await invoke([
      "places",
      "details",
      "get",
      placeId,
      "--session-token",
      lookupToken,
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("maps save exact PNG bytes for zero and boundary coordinates and report JSON metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-map-"));
  try {
    for (const [latitude, longitude] of [
      [0, 0],
      [-90, -180],
      [90, 180],
    ]) {
      const output = path.join(directory, `map ${latitude} ${longitude}.png`),
        result = await invoke(
          [
            "places",
            "static-map",
            "download",
            "--latitude",
            String(latitude),
            "--longitude",
            String(longitude),
            "--output",
            output,
            "--compact",
          ],
          { reply: pngResponse(), env: session }
        );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(await readFile(output), Buffer.from(png));
      assert.deepEqual(JSON.parse(result.stdout), {
        path: output,
        contentType: "image/png",
        bytesWritten: png.byteLength,
      });
      const request = result.requests[0],
        url = new URL(request.url);
      assert.equal(url.pathname, "/v1/places/static-map");
      assert.equal(url.searchParams.get("latitude"), String(latitude));
      assert.equal(url.searchParams.get("longitude"), String(longitude));
      assert.equal(url.searchParams.has("sessionToken"), false);
      assert.equal(request.init.body, undefined);
      assert.equal(new Headers(request.init.headers).get("x-project-id"), null);
      assert(new Headers(request.init.headers).get("accept")?.includes("image/png"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("map coordinates, file destinations, and existing files are checked before billed requests", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-output-"));
  try {
    const existing = path.join(directory, "existing.png");
    await writeFile(existing, "keep this");
    const invalid = [
      ["--latitude", "0", "--longitude", "0"],
      ["--latitude", "0", "--longitude", "0", "--output", "-"],
      ["--latitude", "0", "--longitude", "0", "--output", existing],
      [
        "--latitude",
        "0",
        "--longitude",
        "0",
        "--output",
        path.join(directory, "missing", "map.png"),
      ],
      ["--latitude", "91", "--longitude", "0", "--output", path.join(directory, "lat.png")],
      ["--latitude", "0", "--longitude", "-181", "--output", path.join(directory, "lng.png")],
      ["--latitude", "NaN", "--longitude", "0", "--output", path.join(directory, "nan.png")],
      ["--latitude", "0", "--output", path.join(directory, "missing-coordinate.png")],
    ];
    for (const args of invalid) {
      const result = await invoke(["places", "static-map", "download", ...args], {
        reply: pngResponse(),
      });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.requests.length, 0);
    }
    assert.equal(await readFile(existing, "utf8"), "keep this");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("JSON errors, wrong media types, truncated headers, and unexpected statuses create no map file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-invalid-map-"));
  try {
    const replies = [
      new Response("not an image", { headers: { "content-type": "image/png" } }),
      new Response(png),
      new Response(png, { headers: { "content-type": "image/jpeg" } }),
      new Response(png.slice(0, 7), { headers: { "content-type": "image/png" } }),
      new Response(png, { status: 201, headers: { "content-type": "image/png" } }),
      new Response(null, { status: 204 }),
      Response.json(
        { error: { code: "PROVIDER_UNAVAILABLE", message: "Map unavailable" }, meta },
        { status: 503 }
      ),
    ];
    for (const [index, reply] of replies.entries()) {
      const output = path.join(directory, `${index}.png`),
        result = await invoke(mapArgs(output), { reply });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.requests.length, 1);
      await assert.rejects(readFile(output), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("interrupted PNG bodies do not leave an output file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-stream-"));
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(png.slice(0, 8));
        controller.error(new Error("upstream interrupted"));
      },
    });
    const output = path.join(directory, "interrupted.png"),
      result = await invoke(mapArgs(output), {
        reply: new Response(stream, { headers: { "content-type": "image/png" } }),
      });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("a file created while the map request runs is never overwritten", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-places-race-"));
  try {
    const output = path.join(directory, "map.png"),
      result = await invoke(mapArgs(output), {
        reply: pngResponse(),
        beforeReply: async () => {
          await writeFile(output, "another writer", { flag: "wx" });
        },
      });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "OUTPUT_ERROR");
    assert.equal(await readFile(output, "utf8"), "another writer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("permission, quota, configuration, and network failures never retry lookup work", async () => {
  for (const [status, code] of [
    [403, "INSUFFICIENT_PERMISSIONS"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
    [500, "CONFIGURATION_ERROR"],
  ] as const) {
    const details = { action: "counterparties.manage", nested: [apiKey.SDP_API_KEY] },
      reply = Response.json(
        { error: { code, message: "Lookup refused", details }, meta },
        { status }
      );
    const result = await invoke(
      ["places", "autocomplete", "--input", input, "--session-token", lookupToken],
      { reply }
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(result.stdout, "");
    assert(!result.stderr.includes(apiKey.SDP_API_KEY));
    assert.equal(JSON.parse(result.stderr).error.details.action, details.action);
  }
  const failed = await invoke(
    ["places", "details", "get", place.placeId, "--session-token", lookupToken],
    {
      failure: new Error(`network ${apiKey.SDP_API_KEY}`),
    }
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.requests.length, 1);
  assert(!failed.stderr.includes(apiKey.SDP_API_KEY));
});
test("malformed JSON results never print partial address data", async () => {
  const replies = [
    response({ place: { ...place, location: { latitude: "0", longitude: 0 } } }),
    response({ place: { ...place, addressFields: { line1: "only one field" } } }),
    response({}),
    response({ place }, 201),
  ];
  for (const reply of replies) {
    const result = await invoke(
      ["places", "details", "get", place.placeId, "--session-token", lookupToken],
      {
        reply,
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
  const result = await invoke(
    ["places", "autocomplete", "--input", input, "--session-token", lookupToken],
    { reply: response({ suggestions: [{ mainText: "Missing ID" }] }) }
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
});
