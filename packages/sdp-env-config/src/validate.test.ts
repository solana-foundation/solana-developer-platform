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

test("utila signing requires Utila credentials", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDER: "utila",
    FEE_PAYMENT_PROVIDER: "kora",
    UTILA_SERVICE_ACCOUNT_EMAIL: "",
    UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: "",
    UTILA_VAULT_ID: "",
    UTILA_WALLET_ID: "",
  });

  assert.ok(errors.UTILA_SERVICE_ACCOUNT_EMAIL);
  assert.ok(errors.UTILA_SERVICE_ACCOUNT_PRIVATE_KEY);
  assert.ok(errors.UTILA_VAULT_ID);
  assert.ok(errors.UTILA_WALLET_ID);
});

test("valid utila signing config has no Utila field errors", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDER: "utila",
    FEE_PAYMENT_PROVIDER: "kora",
    UTILA_SERVICE_ACCOUNT_EMAIL: "service@vault.example.utilaserviceaccount.io",
    UTILA_SERVICE_ACCOUNT_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    UTILA_VAULT_ID: "vault_123",
    UTILA_WALLET_ID: "wallet_123",
    UTILA_NETWORK: "networks/solana-devnet",
    UTILA_API_BASE_URL: "https://api.utila.io",
    UTILA_POLL_INTERVAL_MS: "1000",
    UTILA_MAX_POLL_ATTEMPTS: "60",
    UTILA_DESIGNATED_SIGNERS: "users/service@vault.example.utilaserviceaccount.io",
  });

  for (const key of [
    "UTILA_SERVICE_ACCOUNT_EMAIL",
    "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
    "UTILA_VAULT_ID",
    "UTILA_WALLET_ID",
    "UTILA_NETWORK",
    "UTILA_API_BASE_URL",
    "UTILA_POLL_INTERVAL_MS",
    "UTILA_MAX_POLL_ATTEMPTS",
    "UTILA_DESIGNATED_SIGNERS",
  ]) {
    assert.equal(errors[key], undefined, `${key}: ${errors[key]}`);
  }
});

test("a value with a newline is rejected as multi-line", () => {
  const errors = validateValues({
    ...defaultValues(),
    CLERK_SECRET_KEY: "sk_live_abc\nINJECTED=evil",
  });
  assert.match(errors.CLERK_SECRET_KEY ?? "", /single line/);
});
