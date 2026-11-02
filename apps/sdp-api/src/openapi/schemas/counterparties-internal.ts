import { z } from "zod";
import {
  listCounterpartyAccountsQuerySchema as listProjectCounterpartyAccountsQuerySchemaBase,
  submitCounterpartyRequirementsSchema,
} from "@/routes/counterparties/schemas";
import { withOpenApi } from "./base";

export const listProjectCounterpartyAccountsQuerySchema =
  listProjectCounterpartyAccountsQuerySchemaBase.extend({
    type: withOpenApi(listProjectCounterpartyAccountsQuerySchemaBase.shape.type, {
      description: "Recipient summary type.",
      example: "crypto_account",
    }),
    search: withOpenApi(listProjectCounterpartyAccountsQuerySchemaBase.shape.search, {
      description: "Search counterparty display names.",
      example: "Treasury",
    }),
    ids: withOpenApi(listProjectCounterpartyAccountsQuerySchemaBase.shape.ids, {
      description: "Comma-separated counterparty account IDs to resolve without pagination.",
      example: "cpa_one,cpa_two",
    }),
  });

export const listProjectCounterpartyAccountsResponseSchema = z.object({
  accounts: z.array(
    z.object({
      counterpartyId: z.string(),
      counterpartyAccountId: z.string(),
      name: z.string(),
      address: z.string(),
      label: z.string().nullable(),
    })
  ),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export const submitCounterpartyRequirementsRequestSchema = withOpenApi(
  submitCounterpartyRequirementsSchema,
  { description: "Provider and direction for the existing requirements submission operation." }
);
