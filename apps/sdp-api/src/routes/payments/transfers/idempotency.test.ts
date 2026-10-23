import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@/lib/idempotency";
import { canonicalizePaymentBody } from "@/routes/payments/fingerprint";
import { canonicalizeTransferBody, previousCanonicalTransferBody } from "./idempotency";

const USDC = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

const body = {
  sourceCustodyWalletId: "cwlt_1",
  destination: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
  token: "USDC",
  amount: "1.50",
};

/** Runs a fingerprint form as a sandbox project's request does: its tokens resolve on devnet. */
function onDevnet(form: (request: JsonValue) => JsonValue) {
  return (request: JsonValue): JsonValue =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, () => form(request));
}

const canonical = onDevnet(canonicalizeTransferBody);
const previous = onDevnet(previousCanonicalTransferBody);

describe("canonicalizeTransferBody", () => {
  it("hashes the intent: the asset, the canonical amount and the basis with its default", () => {
    const { token: _token, ...rest } = body;
    expect(canonical(body)).toEqual({ ...rest, asset: USDC, amount: "1.5", amountBasis: "debit" });
    expect(canonical({ ...body, token: USDC, amount: "1.5", amountBasis: "debit" })).toEqual(
      canonical(body)
    );
    expect(canonical({ ...body, amountBasis: "credit" })).not.toEqual(canonical(body));
  });

  it("spells native SOL as native and the wrapped SOL mint as its own asset", () => {
    expect(canonical({ ...body, token: "SOL" })).toMatchObject({ asset: "native" });
    // A wrapped SOL request is refused when it runs, after the replay step.
    expect(canonical({ ...body, token: SOL_MINT })).toMatchObject({ asset: SOL_MINT });
  });

  it("defaults an off-ramp deposit's basis to credit", () => {
    expect(canonical({ ...body, transferId: "xfr_1" })).toMatchObject({ amountBasis: "credit" });
    expect(canonical({ ...body, transferId: "xfr_1", amountBasis: "credit" })).toEqual(
      canonical({ ...body, transferId: "xfr_1" })
    );
  });
});

describe("previousCanonicalTransferBody", () => {
  it("is the form before ADR 0012 for a body without a basis", () => {
    expect(previous(body)).toEqual(onDevnet(canonicalizePaymentBody)(body));
    expect(previous(body)).toEqual({ ...body, token: USDC, amount: "1.5" });
  });

  it("spells native SOL as the wrapped SOL mint, as it executed before ADR 0012", () => {
    expect(previous({ ...body, token: "SOL" })).toEqual(previous({ ...body, token: SOL_MINT }));
  });

  it("drops a default basis, so a retry that spells it out still matches", () => {
    expect(previous({ ...body, amountBasis: "debit" })).toEqual(previous(body));
    expect(previous({ ...body, transferId: "xfr_1", amountBasis: "credit" })).toEqual(
      previous({ ...body, transferId: "xfr_1" })
    );
  });

  it("keeps any other basis, so it never matches a movement recorded on the default", () => {
    expect(previous({ ...body, amountBasis: "credit" })).toEqual({
      ...body,
      token: USDC,
      amount: "1.5",
      amountBasis: "credit",
    });
  });
});
