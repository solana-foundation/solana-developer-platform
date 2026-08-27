import { describe, expect, it } from "vitest";
import { createCounterpartySchema, updateCounterpartySchema } from "./schemas";

describe("createCounterpartySchema", () => {
  it.each(["individual", "business"] as const)("accepts a %s counterparty", (entityType) => {
    const result = createCounterpartySchema.safeParse({
      entityType,
      displayName: "Acme Corp",
      externalId: "customer_42",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        entityType,
        displayName: "Acme Corp",
        externalId: "customer_42",
      });
    }
  });

  it("accepts an omitted external ID", () => {
    expect(
      createCounterpartySchema.safeParse({ entityType: "individual", displayName: "Jane Doe" })
        .success
    ).toBe(true);
  });

  it.each([
    { displayName: "Jane Doe" },
    { entityType: "individual" },
    { entityType: "nonprofit", displayName: "Acme" },
    { entityType: "business", displayName: "" },
  ])("rejects an invalid create payload %#", (payload) => {
    expect(createCounterpartySchema.safeParse(payload).success).toBe(false);
  });
});

describe("updateCounterpartySchema", () => {
  it.each([
    { displayName: "Updated name" },
    { entityType: "business" },
    { externalId: "customer_43" },
    { externalId: null },
  ])("accepts the surviving update field %#", (payload) => {
    expect(updateCounterpartySchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an empty update", () => {
    expect(updateCounterpartySchema.safeParse({}).success).toBe(false);
  });
});
