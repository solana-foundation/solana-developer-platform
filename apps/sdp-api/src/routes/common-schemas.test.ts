import { describe, expect, it } from "vitest";
import { queryBooleanSchema } from "./common-schemas";
import { listCounterpartiesQuerySchema } from "./counterparties/schemas";
import { listCounterpartyAccountsQuerySchema } from "./counterparty-accounts/schemas";
import { listAssetProfilesQuerySchema } from "./asset-profiles/schemas";

describe("queryBooleanSchema", () => {
  it.each([
    { input: "false", expected: false },
    { input: "0", expected: false },
    { input: "true", expected: true },
    { input: "1", expected: true },
  ])("parses '$input' as $expected", ({ input, expected }) => {
    const result = queryBooleanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(expected);
    }
  });

  it.each(["invalid", "2", "yes", "no"])(
    "rejects invalid boolean string value '%s'",
    (input) => {
      const result = queryBooleanSchema.safeParse(input);
      expect(result.success).toBe(false);
    }
  );
});

describe("includeArchived query params integration across route schemas", () => {
  const schemas = [
    { name: "listCounterpartiesQuerySchema", schema: listCounterpartiesQuerySchema },
    { name: "listCounterpartyAccountsQuerySchema", schema: listCounterpartyAccountsQuerySchema },
    { name: "listAssetProfilesQuerySchema", schema: listAssetProfilesQuerySchema },
  ];

  for (const { name, schema } of schemas) {
    describe(name, () => {
      it("parses 'false' as boolean false without truthy string coercion bug", () => {
        const result = schema.safeParse({ includeArchived: "false" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.includeArchived).toBe(false);
        }
      });

      it("parses '0' as boolean false", () => {
        const result = schema.safeParse({ includeArchived: "0" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.includeArchived).toBe(false);
        }
      });

      it("parses 'true' as boolean true", () => {
        const result = schema.safeParse({ includeArchived: "true" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.includeArchived).toBe(true);
        }
      });

      it("parses '1' as boolean true", () => {
        const result = schema.safeParse({ includeArchived: "1" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.includeArchived).toBe(true);
        }
      });

      it("rejects invalid boolean query param", () => {
        const result = schema.safeParse({ includeArchived: "invalid" });
        expect(result.success).toBe(false);
      });
    });
  }
});
