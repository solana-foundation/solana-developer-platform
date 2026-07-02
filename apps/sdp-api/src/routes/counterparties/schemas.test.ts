import { describe, expect, it } from "vitest";
import { createCounterpartySchema, updateCounterpartyObjectSchema } from "./schemas";

const BASE_COUNTERPARTY = {
  entityType: "individual",
  displayName: "Jane Doe",
  email: "jane@example.com",
} as const;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function futureIsoDate(): string {
  const future = new Date();
  future.setUTCFullYear(future.getUTCFullYear() + 1);
  return future.toISOString().slice(0, 10);
}

describe("counterpartyIdentitySchema dateOfBirth", () => {
  it("rejects today's date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { dateOfBirth: todayIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a future date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { dateOfBirth: futureIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a past date", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { dateOfBirth: "1990-01-15" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts an omitted dateOfBirth", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: {},
    });

    expect(result.success).toBe(true);
  });
});

describe("counterpartyIdentitySchema phone", () => {
  it("rejects a non-E.164 short number", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { phone: "12345" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid E.164 number", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { phone: "+14155551234" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a number missing the leading plus", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: { phone: "14155551234" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts an omitted phone", () => {
    const result = createCounterpartySchema.safeParse({
      ...BASE_COUNTERPARTY,
      identity: {},
    });

    expect(result.success).toBe(true);
  });
});

describe("updateCounterpartyObjectSchema identity.dateOfBirth partial update", () => {
  it("rejects today's date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { dateOfBirth: todayIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a future date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { dateOfBirth: futureIsoDate() },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a past date", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { dateOfBirth: "1990-01-15" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts an omitted dateOfBirth", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: {},
    });

    expect(result.success).toBe(true);
  });
});

describe("updateCounterpartyObjectSchema identity.phone partial update", () => {
  it("rejects a non-E.164 short number", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { phone: "12345" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid E.164 number", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { phone: "+14155551234" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a number missing the leading plus", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: { phone: "14155551234" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts an omitted phone", () => {
    const result = updateCounterpartyObjectSchema.safeParse({
      identity: {},
    });

    expect(result.success).toBe(true);
  });
});
