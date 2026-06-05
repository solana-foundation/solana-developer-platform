import { COUNTERPARTY_ACCOUNT_KINDS } from "@sdp/types";
import { z } from "zod";
import { isAddress } from "@/lib/solana";

export const counterpartyAccountKindSchema = z.enum(COUNTERPARTY_ACCOUNT_KINDS);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const cryptoWalletDetailsSchema = z
  .object({
    network: z.literal("solana"),
    address: z.string().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    if (!(value.address.length >= 32 && value.address.length <= 44 && isAddress(value.address))) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "address must be a base58 Solana address",
      });
    }
  });

export const createCounterpartyAccountSchema = z
  .object({
    accountKind: counterpartyAccountKindSchema,
    label: z.string().min(1).max(256).optional(),
    details: jsonObjectSchema.optional(),
    providerAccountData: jsonObjectSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.accountKind === "crypto_wallet") {
      const result = cryptoWalletDetailsSchema.safeParse(value.details);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["details"],
          message: "crypto_wallet accounts require details.network and details.address",
        });
      }
    }
  });

export const updateCounterpartyAccountObjectSchema = z.object({
  label: z.string().min(1).max(256).nullable().optional(),
  details: jsonObjectSchema.optional(),
  providerAccountData: jsonObjectSchema.optional(),
});

export const updateCounterpartyAccountSchema = updateCounterpartyAccountObjectSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be provided" }
);

export const counterpartyAccountParamsSchema = z.object({
  counterpartyId: z.string().min(1),
  counterpartyAccountId: z.string().min(1),
});

export const counterpartyAccountListParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const listCounterpartyAccountsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.coerce.boolean().default(false),
  accountKind: counterpartyAccountKindSchema.optional(),
});
