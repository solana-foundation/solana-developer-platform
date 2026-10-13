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
  // CUSTODY_PRIVATE_KEY is required but hidden unless "local" is in SIGNING_PROVIDERS.
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "fireblocks",
    SIGNING_PROVIDER: "fireblocks",
    CUSTODY_PRIVATE_KEY: "",
    FIREBLOCKS_API_KEY: "k",
    FIREBLOCKS_API_SECRET: "s",
    FIREBLOCKS_VAULT_ID: "0",
  });
  assert.equal(errors.CUSTODY_PRIVATE_KEY, undefined);
});

test("a select value outside its options reports an error", () => {
  const errors = validateValues({ ...defaultValues(), ENVIRONMENT: "staging" });
  assert.match(errors.ENVIRONMENT ?? "", /must be one of: production, development/);
});

test("a valid select value has no error", () => {
  const errors = validateValues({ ...defaultValues(), ENVIRONMENT: "development" });
  assert.equal(errors.ENVIRONMENT, undefined);
});

test("a config with only mainnet RPC providers still requires a devnet provider", () => {
  const errors = validateValues({
    ...defaultValues(),
    RPC_DEVNET_PROVIDERS: "",
    RPC_MAINNET_PROVIDERS: "helius",
    SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL: "https://mainnet.helius.rpc.sdp.test/key",
  });
  assert.match(errors.RPC_DEVNET_PROVIDERS ?? "", /is required/);
  assert.equal(errors.RPC_MAINNET_PROVIDERS, undefined);
  assert.equal(errors.SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL, undefined);
});

test("a selected RPC provider without its URL reports an error on that URL", () => {
  const errors = validateValues({
    ...defaultValues(),
    RPC_DEVNET_PROVIDERS: "helius",
    SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://devnet.helius.rpc.sdp.test/key",
    RPC_MAINNET_PROVIDERS: "triton",
    SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "",
  });
  assert.match(errors.SOLANA_RPC_TRITON_MAINNET_API_KEY_URL ?? "", /is required/);
  assert.equal(errors.SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL, undefined);
});

test("an RPC URL whose provider is missing from its own cluster's list reports an error on that URL", () => {
  const errors = validateValues({
    ...defaultValues(),
    RPC_DEVNET_PROVIDERS: "helius",
    SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "https://devnet.helius.rpc.sdp.test/key",
    SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://devnet.triton.rpc.sdp.test/key",
    RPC_MAINNET_PROVIDERS: "triton",
    SOLANA_RPC_TRITON_MAINNET_API_KEY_URL: "https://mainnet.triton.rpc.sdp.test/key",
  });
  assert.equal(
    errors.SOLANA_RPC_TRITON_DEVNET_API_KEY_URL,
    "Triton devnet URL is set but triton is not in RPC_DEVNET_PROVIDERS, so it would be dropped"
  );
  assert.equal(errors.SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL, undefined);
  assert.equal(errors.SOLANA_RPC_TRITON_MAINNET_API_KEY_URL, undefined);
});

test("a non-https RPC URL reports an error", () => {
  const errors = validateValues({
    ...defaultValues(),
    RPC_DEVNET_PROVIDERS: "helius",
    SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL: "http://devnet.helius.rpc.sdp.test/key",
  });
  assert.match(errors.SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL ?? "", /invalid format/);
});

test("managed signing with native fees requires a fee payer key", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "fireblocks",
    SIGNING_PROVIDER: "fireblocks",
    FEE_PAYMENT_PROVIDER: "native",
    FEE_PAYER_PRIVATE_KEY: "",
  });
  assert.ok(errors.FEE_PAYER_PRIVATE_KEY);
});

test("local signing with native fees does not require a fee payer key", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "local",
    SIGNING_PROVIDER: "local",
    CUSTODY_PRIVATE_KEY: "k",
    FEE_PAYMENT_PROVIDER: "native",
    FEE_PAYER_PRIVATE_KEY: "",
  });
  assert.equal(errors.FEE_PAYER_PRIVATE_KEY, undefined);
});

test("utila signing requires Utila credentials", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "utila",
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
    SIGNING_PROVIDERS: "utila",
    SIGNING_PROVIDER: "utila",
    FEE_PAYMENT_PROVIDER: "kora",
    UTILA_SERVICE_ACCOUNT_EMAIL: "service@vault.example.utilaserviceaccount.io",
    UTILA_SERVICE_ACCOUNT_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    UTILA_VAULT_ID: "vault_123",
    UTILA_WALLET_ID: "wallet_123",
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
    "UTILA_API_BASE_URL",
    "UTILA_POLL_INTERVAL_MS",
    "UTILA_MAX_POLL_ATTEMPTS",
    "UTILA_DESIGNATED_SIGNERS",
  ]) {
    assert.equal(errors[key], undefined, `${key}: ${errors[key]}`);
  }
});

test("Privy setup requires an existing wallet", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "privy",
    SIGNING_PROVIDER: "privy",
    PRIVY_APP_ID: "app-id",
    PRIVY_APP_SECRET: "app-secret",
    PRIVY_WALLET_ID: "",
  });

  assert.ok(errors.PRIVY_WALLET_ID);
});

test("an unknown provider in SIGNING_PROVIDERS reports an error", () => {
  const errors = validateValues({ ...defaultValues(), SIGNING_PROVIDERS: "local,bogus" });
  assert.match(errors.SIGNING_PROVIDERS ?? "", /must be one of/);
});

test("a default provider outside the selected set reports an error", () => {
  const errors = validateValues({
    ...defaultValues(),
    SIGNING_PROVIDERS: "local",
    SIGNING_PROVIDER: "fireblocks",
  });
  assert.match(errors.SIGNING_PROVIDER ?? "", /must be one of: local/);
});

test("manual Postgres password is required when empty", () => {
  const errors = validateValues({
    ...defaultValues(),
    POSTGRES_PASSWORD_MODE: "manual",
    POSTGRES_PASSWORD: "",
  });
  assert.ok(errors.POSTGRES_PASSWORD);
});

test("an always-emitted password is validated even when hidden by external DB", () => {
  // POSTGRES_PASSWORD is hidden under an external database but still emitted and
  // required, so an empty value must be caught rather than silently omitted.
  const errors = validateValues({
    ...defaultValues(),
    DATABASE_MODE: "external",
    DATABASE_URL: "postgresql://u@h:5432/d",
    POSTGRES_PASSWORD: "",
  });
  assert.ok(errors.POSTGRES_PASSWORD);
});

test("a value with a newline is rejected as multi-line", () => {
  const errors = validateValues({
    ...defaultValues(),
    CLERK_SECRET_KEY: "sk_live_abc\nINJECTED=evil",
  });
  assert.match(errors.CLERK_SECRET_KEY ?? "", /single line/);
});
