import { describe, expect, it } from "vitest";
import { createCounterpartySchema, updateCounterpartyObjectSchema } from "./schemas";

const BASE_COUNTERPARTY = {
  entityType: "individual",
  displayName: "Jane Doe",
  email: "jane@example.com",
} as const;

const BASE_IDENTITY = {
  firstName: "Jane",
  lastName: "Doe",
  dateOfBirth: "1990-01-15",
  phone: "+14155551234",
  address: {
    line1: "1 Market St",
    city: "San Francisco",
    countryCode: "US",
  },
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

describe("counterpartyIdentitySchema phone", () => {
  it("rejects a non-E.164 short number", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, phone: "12345" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid E.164 number", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, phone: "+14155551234" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a number missing the leading plus", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, phone: "14155551234" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an omitted phone", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { ...BASE_IDENTITY, phone: undefined },
    });

    expect(result.success).toBe(false);
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

describe("updateCounterpartyObjectSchema identity.phone partial update", () => {
  it("rejects a non-E.164 short number", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, phone: "12345" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid E.164 number", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, phone: "+14155551234" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a number missing the leading plus", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, phone: "14155551234" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an omitted phone when identity is provided", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { ...BASE_IDENTITY, phone: undefined },
    });

    expect(result.success).toBe(false);
  });
});
