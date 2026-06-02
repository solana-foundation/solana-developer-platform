import assert from "node:assert/strict";
import test from "node:test";
import { defaultValues } from "./generate";
import { validateValues } from "./validate";

test("required visible field with empty value reports an error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "" });
  assert.ok(errors.CLERK_SECRET_KEY);
});

test("pattern mismatch reports an error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "nope" });
  assert.ok(errors.CLERK_SECRET_KEY);
});

test("valid value has no error", () => {
  const errors = validateValues({ ...defaultValues(), CLERK_SECRET_KEY: "sk_live_abc" });
  assert.equal(errors.CLERK_SECRET_KEY, undefined);
});

test("invisible required field is not validated", () => {
  // CUSTODY_PRIVATE_KEY is required but hidden unless SIGNING_PROVIDER=local
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDER: "fireblocks",
    CUSTODY_PRIVATE_KEY: "",
  });
  assert.equal(errors.CUSTODY_PRIVATE_KEY, undefined);
});

test("a select value outside its options reports an error", () => {
  const errors = validateValues({ ...defaultValues(), SOLANA_NETWORK: "testnet" });
  assert.match(errors.SOLANA_NETWORK ?? "", /must be one of: devnet, mainnet-beta/);
});

test("a valid select value has no error", () => {
  const errors = validateValues({ ...defaultValues(), SOLANA_NETWORK: "mainnet-beta" });
  assert.equal(errors.SOLANA_NETWORK, undefined);
});

test("managed signing with native fees requires a fee payer key", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDER: "fireblocks",
    FEE_PAYMENT_PROVIDER: "native",
    FEE_PAYER_PRIVATE_KEY: "",
  });
  assert.ok(errors.FEE_PAYER_PRIVATE_KEY);
});

test("local signing with native fees does not require a fee payer key", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDER: "local",
    FEE_PAYMENT_PROVIDER: "native",
    FEE_PAYER_PRIVATE_KEY: "",
  });
  assert.equal(errors.FEE_PAYER_PRIVATE_KEY, undefined);
});

test("a value with a newline is rejected as multi-line", () => {
  const errors = validateValues({
    ...defaultValues(),
    CLERK_SECRET_KEY: "sk_live_abc\nINJECTED=evil",
  });
  assert.match(errors.CLERK_SECRET_KEY ?? "", /single line/);
});
