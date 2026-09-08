/**
 * The representative payload every sink is tested against.
 *
 * One shared fixture rather than per-test literals: a sink is only proven
 * covered if it faces the PII the platform actually stores — the counterparty
 * identity shape, its contact and bank details, a provider credential — and if
 * the same assertion also proves the Solana address and resource ids survived.
 * Test-only; not exported from the package entry point.
 */

import assert from "node:assert/strict";

export const SOLANA_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export const COUNTERPARTY_PAYLOAD = {
  counterpartyId: "cp_01HZY",
  organizationId: "org_01HZY",
  displayName: "Jane Doe",
  email: "jane.doe@example.com",
  entityType: "individual",
  identity: {
    firstName: "Jane",
    lastName: "Doe",
    dateOfBirth: "1988-04-02",
    phone: "+15551234567",
    address: {
      line1: "12 Rue de Rivoli",
      city: "Paris",
      postalCode: "75001",
      countryCode: "FR",
      subdivisionCode: "IDF",
    },
  },
  account: {
    accountKind: "bank_account",
    details: {
      accountNumber: "000123456789",
      routingNumber: "021000021",
      iban: "FR7630006000011234567890189",
      accountHolderName: "Jane Doe",
    },
  },
  wallet: {
    walletId: "wlt_01HZY",
    walletAddress: SOLANA_ADDRESS,
    destinationAddress: SOLANA_ADDRESS,
  },
  // Corridor context, outside the identity blob. It is what an on-call engineer
  // reads to tell a provider outage from an unsupported country, and none of it
  // identifies anyone once the name, phone, date of birth, and street are gone.
  corridor: {
    countryCode: "FR",
    subdivisionCode: "IDF",
    currencyCode: "EUR",
  },
  provider: {
    appSecret: "privy-app-secret-value",
    authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    pem: "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----",
  },
};

/** Values that must be absent from anything a sink receives. */
const FORBIDDEN_VALUES = [
  "jane.doe@example.com",
  "Jane",
  "Doe",
  "1988-04-02",
  "+15551234567",
  "12 Rue de Rivoli",
  "Paris",
  "75001",
  "000123456789",
  "021000021",
  "FR7630006000011234567890189",
  "privy-app-secret-value",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "MIIBVgIBADANBgkqhkiG9w0",
];

/**
 * Values that must survive, or the scrubber has overreached. The address
 * components inside `identity` are not here: that whole blob is denylisted as a
 * unit, so its `countryCode` goes with it — which is why the corridor context is
 * carried as a sibling.
 */
const REQUIRED_VALUES = ["cp_01HZY", "org_01HZY", "wlt_01HZY", SOLANA_ADDRESS, "FR", "IDF", "EUR"];

/**
 * Asserts both halves of the contract against a serialized payload: nothing
 * identifying survived, and everything operational did.
 */
export function assertScrubbed(serialized: string): void {
  for (const forbidden of FORBIDDEN_VALUES) {
    assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}: ${serialized}`);
  }
  for (const required of REQUIRED_VALUES) {
    assert.ok(serialized.includes(required), `over-redacted ${required}: ${serialized}`);
  }
}
