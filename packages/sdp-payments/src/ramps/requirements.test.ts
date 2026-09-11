import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { SdpPaymentsError } from "../errors";
import { consentField, parseCollectedFields } from "./requirements";

const terms = consentField({
  key: "acceptTerms",
  label: "I have read and accept the",
  documentLabel: "Terms",
  documentUrl: "https://example.com/terms",
  required: true,
});

describe("consent requirement fields", () => {
  it("accepts only the affirmative literal when required", () => {
    assert.deepEqual(parseCollectedFields([terms], { acceptTerms: "true" }, "bad"), {
      acceptTerms: "true",
    });
    for (const value of ["false", "", "yes", "TRUE"]) {
      assert.throws(
        () => parseCollectedFields([terms], { acceptTerms: value }, "bad"),
        (error: unknown) => error instanceof SdpPaymentsError && error.code === "BAD_REQUEST"
      );
    }
    assert.throws(() => parseCollectedFields([terms], {}, "bad"), SdpPaymentsError);
  });

  it("lets an optional consent be left unticked, however the client spells that", () => {
    const optional = { ...terms, required: false };
    const spellings: CollectedFieldData[] = [
      {},
      { acceptTerms: "" },
      { acceptTerms: "false" },
      { acceptTerms: "true" },
    ];
    for (const data of spellings) {
      assert.doesNotThrow(() => parseCollectedFields([optional], data, "bad"));
    }
  });
});
