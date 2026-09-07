import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCredentialKey,
  isPiiKey,
  isSensitiveKey,
  NEVER_REDACTED_KEYS,
  normalizeKey,
} from "./policy";

describe("normalizeKey", () => {
  it("collapses separators and case so one rule covers every spelling", () => {
    for (const spelling of ["apiSecret", "api_secret", "API-SECRET", "Api Secret"]) {
      assert.equal(normalizeKey(spelling), "apisecret", spelling);
    }
  });
});

describe("isCredentialKey", () => {
  it("matches the credential shapes providers use", () => {
    for (const key of [
      "appSecret",
      "apiSecret",
      "api_key",
      "clientSecret",
      "privateKey",
      "turnkeyApiPrivateKey",
      "authorization",
      "password",
      "pem",
      "fireblocksApiSecretPem",
      "accessToken",
      "refresh_token",
      "cookie",
      "setCookie",
      "credentials",
      "secretPayload",
      // Normalization strips the separators, so an exact `apikey` rule would
      // miss the header form. This is the shape that reaches Sentry as
      // `request.headers`.
      "x-api-key",
      "X-Api-Key",
    ]) {
      assert.equal(isCredentialKey(key), true, key);
    }
  });

  it("leaves public ids alone", () => {
    for (const key of ["tokenId", "walletId", "apiKeyId", "credentialId"]) {
      assert.equal(isCredentialKey(key), false, key);
    }
  });
});

describe("isPiiKey", () => {
  it("matches the counterparty identity, contact, and instrument fields", () => {
    for (const key of [
      "email",
      "counterpartyEmail",
      "emailAddress",
      "phone",
      "phoneNumber",
      "firstName",
      "lastName",
      "secondLastName",
      "displayName",
      "accountHolderName",
      "dateOfBirth",
      "dob",
      "line1",
      "line2",
      "city",
      "postalCode",
      "taxId",
      "ssn",
      "passportNumber",
      "accountNumber",
      "iban",
      "routingNumber",
      "identity",
      "providerData",
      "providerAccountData",
      "ipAddress",
      "x_forwarded_for",
    ]) {
      assert.equal(isPiiKey(key), true, key);
    }
  });

  it("does not match the keys the platform is diagnosed with", () => {
    // Every one of these is load-bearing: a Solana address is the handle for
    // tracing a payment, `details` carries validation output, `countryCode`
    // identifies a ramp corridor.
    for (const key of NEVER_REDACTED_KEYS) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });

  it("covers every provider spelling of a street line", () => {
    // The `address` container is excluded to protect Solana addresses, so the
    // street line is only defused if each provider's spelling is named. These
    // are the shapes actually submitted: `MuralPhysicalAddress` in the Mural
    // client, `BvnkRuleEntityAddress` in BVNK's provider-data, and SDP's own
    // `CounterpartyAddress`.
    for (const key of [
      "line1",
      "address1",
      "addressLine1",
      "physicalAddress",
      "residentialAddress",
    ]) {
      assert.equal(isPiiKey(key), true, key);
    }
  });

  it("still exempts crypto addresses that read like postal keys", () => {
    // BVNK's `beneficiaryAddress` carries `destinationWalletAddress` — a crypto
    // address. This is why there is no `*Address` suffix rule.
    for (const key of ["beneficiaryAddress", "cryptoAddress", "destinationAddress"]) {
      assert.equal(isPiiKey(key), false, key);
    }
  });

  it("keeps bank identifiers that name an institution rather than a person", () => {
    for (const key of ["swiftCode", "bic", "bankName", "currencyCode"]) {
      assert.equal(isPiiKey(key), false, key);
    }
  });
});
