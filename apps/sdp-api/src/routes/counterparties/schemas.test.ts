import { describe, expect, it } from "vitest";
import {
  counterpartyRequirementsQuerySchema,
  createCounterpartySchema,
  updateCounterpartyObjectSchema,
} from "./schemas";

const BASE_COUNTERPARTY = {
  entityType: "individual",
  displayName: "Jane Doe",
  email: "jane@example.com",
} as const;

const BASE_IDENTITY = {
  firstName: "Jane",
  lastName: "Doe",
  dateOfBirth: "1990-01-15",
} as const;

function futureIsoDate(): string {
  const future = new Date();
  future.setUTCFullYear(future.getUTCFullYear() + 1);
  return future.toISOString().slice(0, 10);
}

describe("counterpartyIdentitySchema dateOfBirth", () => {
  it("rejects today's date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: {
        ...BASE_IDENTITY,
        dateOfBirth: new Date().toISOString().slice(0, 10),
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a future date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, dateOfBirth: futureIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a past date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, dateOfBirth: "1990-01-15" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an omitted dateOfBirth", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, dateOfBirth: undefined },
    });

    expect(result.success).toBe(false);
  });
});

describe("counterparty identity JIT fields", () => {
  it("strips phone and address from create payloads", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: {
        ...BASE_IDENTITY,
        phone: "+14155551234",
        address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
      },
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("Expected create payload to parse");
    if (result.data.entityType !== "individual") {
      throw new Error("Expected individual payload");
    }
    expect(result.data.identity).toEqual(BASE_IDENTITY);
  });

  it("strips phone and address from update payloads", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: {
        ...BASE_IDENTITY,
        phone: "+14155551234",
        address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
      },
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("Expected update payload to parse");
    expect(result.data.identity).toEqual(BASE_IDENTITY);
  });

  it("strips identity from business create payloads", () => {
    const result = createCounterpartySchema.safeParse({
      entityType: "business",
      displayName: "Acme Inc.",
      email: "ops@acme.example",
      identity: {
        address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
      },
    });

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("Expected business payload to parse");
    expect(result.data).not.toHaveProperty("identity");
  });
});

describe("counterpartyRequirementsQuerySchema country", () => {
  const ONRAMP_QUERY = {
    provider: "coinbase",
    direction: "onramp",
    cryptoToken: "USDC_SOLANA",
    fiatCurrency: "USD",
    destinationWallet: "wallet_1",
  } as const;

  it("requires a supported country for on-ramp requirements", () => {
    expect(counterpartyRequirementsQuerySchema.safeParse(ONRAMP_QUERY).success).toBe(false);
    expect(
      counterpartyRequirementsQuerySchema.safeParse({ ...ONRAMP_QUERY, country: "US" }).success
    ).toBe(true);
    expect(
      counterpartyRequirementsQuerySchema.safeParse({ ...ONRAMP_QUERY, country: "us" }).success
    ).toBe(false);
  });

  it("requires a supported country for off-ramp requirements", () => {
    const query = {
      provider: "mural",
      direction: "offramp",
      cryptoToken: "USDC_SOLANA",
      fiatCurrency: "USD",
    } as const;
    expect(counterpartyRequirementsQuerySchema.safeParse(query).success).toBe(false);
    expect(counterpartyRequirementsQuerySchema.safeParse({ ...query, country: "GB" }).success).toBe(
      true
    );
  });
});

describe("updateCounterpartyObjectSchema identity.dateOfBirth partial update", () => {
  it("rejects today's date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: {
        ...BASE_IDENTITY,
        dateOfBirth: new Date().toISOString().slice(0, 10),
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a future date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, dateOfBirth: futureIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a past date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, dateOfBirth: "1990-01-15" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects an omitted dateOfBirth when identity is provided", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, dateOfBirth: undefined },
    });

    expect(result.success).toBe(false);
  });
});
