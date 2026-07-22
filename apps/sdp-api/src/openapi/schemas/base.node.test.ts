import { describe, expect, it } from "vitest";
import { listAssetProfilesQuerySchema } from "@/routes/asset-profiles/schemas";
import { listCounterpartiesQuerySchema } from "@/routes/counterparties/schemas";
import { listCounterpartyAccountsQuerySchema } from "@/routes/counterparty-accounts/schemas";
import { queryBooleanSchema } from "./base";

describe("queryBooleanSchema", () => {
  it.each([
    { input: "true", expected: true },
    { input: "false", expected: false },
  ])("parses '$input' as $expected", ({ input, expected }) => {
    const result = queryBooleanSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(expected);
    }
  });

  it.each(["1", "0", "TRUE", "False", "yes", "no", "2", "invalid", ""])("rejects '%s'", (input) => {
    expect(queryBooleanSchema.safeParse(input).success).toBe(false);
  });
});

describe("includeArchived query param across route schemas", () => {
  const schemas = [
    { name: "listCounterpartiesQuerySchema", schema: listCounterpartiesQuerySchema },
    { name: "listCounterpartyAccountsQuerySchema", schema: listCounterpartyAccountsQuerySchema },
    { name: "listAssetProfilesQuerySchema", schema: listAssetProfilesQuerySchema },
  ];

  for (const { name, schema } of schemas) {
    describe(name, () => {
      it("parses 'false' as boolean false", () => {
        const result = schema.safeParse({ includeArchived: "false" });
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

      it("defaults to false when omitted", () => {
        const result = schema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.includeArchived).toBe(false);
        }
      });

      it("rejects invalid boolean query param", () => {
        expect(schema.safeParse({ includeArchived: "1" }).success).toBe(false);
      });
    });
  }
});
