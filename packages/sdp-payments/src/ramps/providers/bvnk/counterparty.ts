import { type BvnkFiatCurrency, isBvnkFiatCurrency } from "./currencies";
import type { BvnkRuleEntity, BvnkRuleEntityAddress } from "./provider-data";
import type { BvnkContactV3, BvnkContactV3Address } from "./schemas";

/**
 * Whether BVNK off-ramp settles in the given fiat currency; the only fiats
 * BVNK serves are the sandbox fiat set shared with the on-ramp.
 *
 * @param value - Fiat currency code, for example `USD`.
 * @returns True when the currency is an off-ramp settlement currency.
 */
export function isBvnkOfframpCurrency(value: string): value is BvnkFiatCurrency {
  return isBvnkFiatCurrency(value);
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
