import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type TestContext, test } from "node:test";
import { probeExternalUrl } from "./lib/external-link";

async function probeResponses(t: TestContext, responses: (number | "disconnect")[]) {
  const methods: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    const status = responses[methods.length];
    methods.push(request.method);
    if (status === "disconnect") {
      request.socket.destroy();
    } else {
      response.writeHead(status ?? 500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await probeExternalUrl(`http://127.0.0.1:${address.port}/docs`);
  return { result, methods };
}

for (const status of [200, 401, 403, 429]) {
  test(`accepts HTTP ${status} without retrying`, async (t) => {
    assert.deepEqual(await probeResponses(t, [status]), {
      result: { ok: true, status },
      methods: ["HEAD"],
    });
  });
}

test("falls back to GET when HEAD is unsupported", async (t) => {
  assert.deepEqual(await probeResponses(t, [405, 200]), {
    result: { ok: true, status: 200 },
    methods: ["HEAD", "GET"],
  });
});

test("retries a transient server failure", async (t) => {
  assert.deepEqual(await probeResponses(t, [503, 200]), {
    result: { ok: true, status: 200 },
    methods: ["HEAD", "GET"],
  });
});

test("retries a dropped connection", async (t) => {
  assert.deepEqual(await probeResponses(t, ["disconnect", 200]), {
    result: { ok: true, status: 200 },
    methods: ["HEAD", "GET"],
  });
});

test("retries a transient failure after the HEAD fallback", async (t) => {
  assert.deepEqual(await probeResponses(t, [405, 502, 200]), {
    result: { ok: true, status: 200 },
    methods: ["HEAD", "GET", "GET"],
  });
});

for (const responses of [[404], [405, 404], [503, 404]]) {
  test(`rejects a missing URL after ${responses.join(", ")}`, async (t) => {
    assert.deepEqual(await probeResponses(t, responses), {
      result: { ok: false, status: 404 },
      methods: responses.map((_, index) => (index === 0 ? "HEAD" : "GET")),
    });
  });
}

test("fails after three persistent server errors", async (t) => {
  assert.deepEqual(await probeResponses(t, [503, 503, 503]), {
    result: { ok: false, status: 503 },
    methods: ["HEAD", "GET", "GET"],
  });
});

test("fails after three dropped connections", async (t) => {
  const { result, methods } = await probeResponses(t, ["disconnect", "disconnect", "disconnect"]);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.deepEqual(methods, ["HEAD", "GET", "GET"]);
});
