import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SafeProxyError } from "@sdp/safe-proxy-catalog/errors";
import { type CallerCredentials, createCallerResolver } from "@/caller";

async function assertNotAllowed(resolved: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(resolved, (error: unknown) => {
    assert.ok(error instanceof SafeProxyError, label);
    assert.equal(error.code, "caller_not_allowed", label);
    assert.equal(error.outcome, "rejected", label);
    return true;
  });
}

function credentials(fields: Partial<CallerCredentials>): CallerCredentials {
  return { authorization: undefined, localCaller: undefined, ...fields };
}

describe("createCallerResolver in local mode", () => {
  const resolve = createCallerResolver({ callerAuth: "local", port: 8791 });

  it("resolves the caller the header names", async () => {
    assert.equal(await resolve(credentials({ localCaller: "api" })), "api");
    assert.equal(await resolve(credentials({ localCaller: "cron" })), "cron");
  });

  it("refuses an absent, empty, unknown or differently cased caller name", async () => {
    for (const localCaller of [undefined, "", "worker", "API", "Cron", " api"]) {
      await assertNotAllowed(resolve(credentials({ localCaller })), `${localCaller}`);
    }
  });
});

describe("createCallerResolver in google mode", () => {
  const resolve = createCallerResolver({
    callerAuth: "google",
    port: 8080,
    audience: "https://safe-proxy.example.com",
    callerEmails: { api: "api@example.com", cron: "cron@example.com" },
  });

  it("refuses a request with no authorization header, even when it names a local caller", async () => {
    await assertNotAllowed(resolve(credentials({})), "absent");
    await assertNotAllowed(resolve(credentials({ localCaller: "api" })), "local header");
  });

  it("refuses an authorization header that is not a bearer token", async () => {
    for (const authorization of ["", "Basic YXBpOnNlY3JldA==", "Bearer", "token-without-scheme"]) {
      await assertNotAllowed(resolve(credentials({ authorization })), authorization);
    }
  });
});
