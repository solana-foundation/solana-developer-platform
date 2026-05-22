import { COUNTERPARTY_ID_TYPES } from "@sdp/types";
import { z } from "zod";

// TODO: strict country / subdivision validation deferred — see follow-up ticket
// under PRO-1217. Until then, accept any string and let downstream providers
// reject invalid codes.
const countryCodeSchema = z.string().min(2).max(8);
const subdivisionCodeSchema = z.string().min(1).max(16);

const counterpartyAddressSchema = z.object({
  line1: z.string().min(1).max(512),
  line2: z.string().max(512).optional(),
  city: z.string().min(1).max(256),
  postalCode: z.string().max(32).optional(),
  countryCode: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
});

const counterpartyGovernmentIdSchema = z.object({
  type: z.enum(COUNTERPARTY_ID_TYPES),
  number: z.string().min(1).max(128),
  issueCountry: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema.optional(),
  issueDate: z.iso.date().optional(),
  expiryDate: z.iso.date().optional(),
});

export const counterpartyIdentitySchema = z
  .object({
    firstName: z.string().min(1).max(256).optional(),
    middleName: z.string().max(256).optional(),
    lastName: z.string().min(1).max(256).optional(),
    secondLastName: z.string().max(256).optional(),
    dateOfBirth: z.iso.date().optional(),
    phone: z.string().min(1).max(64).optional(),
    address: counterpartyAddressSchema.optional(),
    birthCountryCode: countryCodeSchema.optional(),
    citizenshipCountryCode: countryCodeSchema.optional(),
    governmentId: counterpartyGovernmentIdSchema.optional(),
  })
  .passthrough();

export const counterpartyEntityTypeSchema = z.enum(["individual", "business"]);

export const counterpartyIdParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const createCounterpartySchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  entityType: counterpartyEntityTypeSchema,
  displayName: z.string().min(1).max(512),
  email: z.string().email().max(512),
  projectId: z.string().min(1).optional(),
  identity: counterpartyIdentitySchema.optional(),
});

export const updateCounterpartySchema = z
  .object({
    externalId: z.string().min(1).max(256).nullable().optional(),
    entityType: counterpartyEntityTypeSchema.optional(),
    displayName: z.string().min(1).max(512).optional(),
    email: z.string().email().max(512).optional(),
    identity: counterpartyIdentitySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const listCounterpartiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().min(1).optional(),
  includeInactive: z.coerce.boolean().default(false),
});
