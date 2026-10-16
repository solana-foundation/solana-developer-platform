import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { SdpPaymentsError } from "../../../errors";
import { bvnkRequestFailure, parseBvnkResponse } from "./errors";

describe("bvnkRequestFailure", () => {
  it("keeps BVNK's code, message and field errors out of the public error", () => {
    const body = {
      code: "BAD_REQUEST",
      message: "dateOfBirth jane.doe@example.com is invalid",
      details: { errors: [{ field: "dateOfBirth", message: "must be in the past" }] },
    };

    const error = bvnkRequestFailure(400, JSON.stringify(body), body);

    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.message, "BVNK request failed with status 400.");
    assert.deepEqual(error.details, { provider: "bvnk", providerStatus: 400, outcome: "rejected" });
    assert.deepEqual(error.diagnostics, {
      providerCode: "BAD_REQUEST",
      providerMessage: body.message,
      providerErrors: body.details.errors,
    });
  });

  it("answers a rate limit with its own wording", () => {
    const body = { code: "RATE_LIMIT", message: "slow down" };

    const error = bvnkRequestFailure(429, JSON.stringify(body), body);

    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.message, "BVNK rate-limited the request (status 429).");
    assert.equal(error.diagnostics?.providerMessage, "slow down");
  });
});

describe("parseBvnkResponse", () => {
  it("reports schema issues in diagnostics, not in public details", () => {
    assert.throws(
      () => parseBvnkResponse(z.object({ walletId: z.string() }), { walletId: 7 }),
      (cause: unknown) => {
        assert.ok(cause instanceof SdpPaymentsError);
        assert.equal(cause.code, "PROVIDER_UNAVAILABLE");
        assert.deepEqual(cause.details, { provider: "bvnk" });
        assert.ok(cause.diagnostics?.issues);
        return true;
      }
    );
  });
});
