import type { Counterparty } from "@sdp/types";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import { badRequest, unsupportedCounterparty } from "../../../errors";
import { readyCounterparty, textField } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  type BvnkRuleEntity,
  type BvnkRuleEntityAddress,
  isBvnkWalletActive,
  latestBvnkOfframpBeneficiary,
  readBvnkOfframpWallet,
} from "./provider-data";
import type { BvnkContactV3, BvnkContactV3Address } from "./schemas";

interface BvnkOfframpSpec {
  accountType: string;
  fields: readonly RequirementField[];
}

/** Verified BVNK payout corridors: each fiat maps to its bank-detail field set. */
const BVNK_OFFRAMP_SPECS = {
  USD: {
    accountType: "ACH",
    fields: [
      textField({
        key: "accountNumber",
        label: "Account number",
        required: true,
        pattern: "^[0-9]{4,17}$",
      }),
      textField({
        key: "routingNumber",
        label: "Routing number",
        required: true,
        pattern: "^[0-9]{9}$",
        placeholder: "021000021",
      }),
    ],
  },
  EUR: {
    accountType: "SEPA_CT",
    fields: [
      textField({
        key: "iban",
        label: "IBAN",
        required: true,
        pattern: "^[A-Z]{2}[0-9A-Z]{13,32}$",
        placeholder: "DE89370400440532013000",
      }),
    ],
  },
} as const satisfies Record<string, BvnkOfframpSpec>;

type BvnkOfframpCurrency = keyof typeof BVNK_OFFRAMP_SPECS;

export function isBvnkOfframpCurrency(value: string): value is BvnkOfframpCurrency {
  return Object.hasOwn(BVNK_OFFRAMP_SPECS, value);
}

export function bvnkOfframpAccountType(fiatCurrency: BvnkOfframpCurrency): string {
  return BVNK_OFFRAMP_SPECS[fiatCurrency].accountType;
}

export function bvnkOfframpFields(fiatCurrency: BvnkOfframpCurrency): RequirementField[] {
  return [...BVNK_OFFRAMP_SPECS[fiatCurrency].fields];
}

export function validateBvnkCounterparty(
  _counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  const { direction, providerData, fiatCurrency } = options;

  if (options.direction === "offramp") {
    if (!fiatCurrency) {
      throw badRequest("fiatCurrency is required for BVNK off-ramp requirements.");
    }
    if (!isBvnkOfframpCurrency(fiatCurrency)) {
      return unsupportedCounterparty(
        "bvnk",
        direction,
        `BVNK off-ramp does not support payouts in ${fiatCurrency}.`
      );
    }
    if (!latestBvnkOfframpBeneficiary(providerData, fiatCurrency)) {
      return {
        provider: "bvnk",
        direction,
        status: "collect",
        fields: bvnkOfframpFields(fiatCurrency),
      };
    }
    const wallet = readBvnkOfframpWallet(providerData, fiatCurrency);
    if (!wallet || !isBvnkWalletActive(wallet.status)) {
      return {
        provider: "bvnk",
        direction,
        status: "provisioning",
      };
    }
    return readyCounterparty("bvnk", direction);
  }

  return readyCounterparty("bvnk", direction);
}

/**
 * Maps a BVNK v3 contact address onto the rule-entity address lanes. The
 * contact's ISO country is mirrored into both `country` and `countryCode`
 * because BVNK rule validation rejects a blank `country` while the v2 channel
 * payload reads `countryCode`.
 *
 * @param address - V3 contact address; its `country` is ISO 3166-1 alpha-2.
 * @returns The rule-entity address with every present lane carried over.
 */
function mapBvnkContactAddress(address: BvnkContactV3Address): BvnkRuleEntityAddress {
  return {
    addressLine1: address.addressLine1,
    ...(address.addressLine2 === undefined ? {} : { addressLine2: address.addressLine2 }),
    ...(address.postalCode === undefined ? {} : { postalCode: address.postalCode }),
    city: address.city,
    countryCode: address.country,
    country: address.country,
    ...(address.stateCode === undefined ? {} : { stateCode: address.stateCode }),
  };
}

/**
 * Builds the THIRD_PARTY rule entity for a BVNK v3 contact, keyed on the SDP
 * counterparty id. The contact is fetched JIT at rule-creation time because
 * BVNK payment rules accept an inline entity, not a contactId.
 *
 * @param contact - BVNK v3 contact bound to the counterparty.
 * @param counterpartyId - SDP counterparty primary key in `cpty_<uuid>` format.
 * @returns The rule beneficiary entity for the contact's entity type.
 */
export function buildBvnkThirdPartyRuleEntity(
  contact: BvnkContactV3,
  counterpartyId: string
): BvnkRuleEntity {
  const { entity } = contact;
  if (entity.type === "INDIVIDUAL") {
    return {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: counterpartyId,
      firstName: entity.firstName,
      lastName: entity.lastName,
      ...(entity.dateOfBirth === undefined ? {} : { dateOfBirth: entity.dateOfBirth }),
      ...(entity.address === undefined ? {} : { address: mapBvnkContactAddress(entity.address) }),
    };
  }
  return {
    type: "COMPANY",
    relationshipType: "THIRD_PARTY",
    customerIdentifier: counterpartyId,
    legalName: entity.legalName,
    ...(entity.registrationNumber === undefined
      ? {}
      : { registrationNumber: entity.registrationNumber }),
    ...(entity.address === undefined ? {} : { address: mapBvnkContactAddress(entity.address) }),
  };
}
