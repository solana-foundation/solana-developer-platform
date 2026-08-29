import { CUSTODY_PROVIDERS, type CustodyProvider } from "./custody";
import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "./organizations";
import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  EARN_PROVIDERS,
  type EarnProviderId,
  ORGANIZATION_PROVIDER_FAMILIES,
  type OrganizationProviderFamily,
  RAMP_PROVIDERS,
  type RampProviderId,
} from "./provider-access";

/**
 * The partner security intake register: one record per third party SDP can hand
 * credentials, personal data, or funds-flow data to.
 *
 * This is the machine-readable half of the intake gate (`docs/security/
 * partner-security-intake.md`, threats SDP-017 and SDP-018, Linear HOO-1003).
 * The prose half describes the review; this file is what the runtime and CI
 * actually enforce, so the two cannot drift into "we wrote a policy and shipped
 * an integration that ignores it".
 *
 * Three properties make it a gate rather than a document:
 *
 * 1. **It is exhaustive by construction.** `PARTNER_INTAKE` is
 *    `satisfies Record<...>` over every id in `CUSTODY_PROVIDERS`,
 *    `ORGANIZATION_RPC_PROVIDERS`, `COMPLIANCE_PROVIDERS`, `RAMP_PROVIDERS` and
 *    `EARN_PROVIDERS`. Registering a partner without answering these questions
 *    is a compile error, which is the only version of this control that survives
 *    contact with a deadline.
 * 2. **`clearance` is load-bearing at runtime.** The API's provider-availability
 *    service refuses a `blocked` partner before it consults entitlement or
 *    credentials, so an integration cannot reach production by having its keys
 *    provisioned. See `assertPartnerIntakeCleared` in
 *    `apps/sdp-api/src/services/provider-availability.service.ts`.
 * 3. **`personalDataFieldAllowlist` is enforced at the egress, not asserted.**
 *    Where a partner client forwards a caller-shaped object of personal data
 *    wholesale, `enforcePartnerFieldAllowlist` (@sdp/payments/ramps/partner-egress)
 *    refuses the request unless every field in it is declared here.
 *
 * ## Honesty about the starting state
 *
 * Most records begin as `provisional`. That status means exactly one thing: the
 * integration predates this register, its answers below were derived by reading
 * the code rather than by reviewing the partner, and no DPA ownership has been
 * recorded. It is a dated exception carrying a ticket, not a pass — and
 * `partner-intake.drift.test.ts` ratchets the set so it can only shrink. Do not
 * add one for new work; a new partner is `blocked` until it is `cleared`.
 */

/**
 * The partner families are exactly the provider families the availability
 * service already resolves. Aliased rather than redeclared so a family added to
 * one list cannot go missing from the other.
 */
export const PARTNER_FAMILIES = ORGANIZATION_PROVIDER_FAMILIES;
export type PartnerFamily = OrganizationProviderFamily;

export type PartnerIdByFamily = {
  custody: CustodyProvider;
  rpc: OrganizationRpcProvider;
  compliance: ComplianceProviderId;
  ramps: RampProviderId;
  earn: EarnProviderId;
};

/**
 * What leaves SDP for a partner, and what SDP keeps about the exchange.
 *
 * Deliberately coarse. A finer taxonomy would be a research project whose
 * output nobody could keep current; these categories are enough to answer the
 * two questions the intake asks — "does a natural person's data reach this
 * partner" and "can this credential move value".
 */
export const PARTNER_DATA_CATEGORIES = [
  /** Organization, project and wallet labels SDP derives from its own records. */
  "organization_identity",
  /** A natural person's name, date of birth, nationality or place of birth. */
  "counterparty_identity",
  /** Government-issued identifiers: tax id, SSN/ITIN, passport, national id. */
  "government_id",
  /** Email, phone and postal address. */
  "contact",
  /** IBAN, account and routing numbers, and other payout instructions. */
  "bank_account",
  /** Solana addresses and other on-chain identifiers. */
  "wallet_address",
  /** Amounts, currencies, signatures, memos and settlement economics. */
  "transaction",
  /** Opaque partner-side identifiers exchanged to correlate records. */
  "provider_reference",
] as const;
export type PartnerDataCategory = (typeof PARTNER_DATA_CATEGORIES)[number];

/**
 * The categories that make a partner a personal-data processor.
 *
 * A partner whose data map intersects this set must answer the PII-minimization
 * half of the intake (`personalDataEgress`), which is the part
 * `partner-intake.drift.test.ts` checks.
 */
export const PARTNER_PERSONAL_DATA_CATEGORIES = [
  "counterparty_identity",
  "government_id",
  "contact",
  "bank_account",
] as const satisfies readonly PartnerDataCategory[];

/**
 * Whether the intake permits SDP to reach the partner at all.
 *
 * `provisional` and `cleared` both pass the runtime gate; they differ in whether
 * a human has actually reviewed the partner. `blocked` is the default for
 * anything new and is what stops a half-built integration from launching
 * because someone provisioned its credentials.
 */
export type PartnerClearance =
  | {
      readonly status: "cleared";
      /** ISO date of the review that produced the answers in this record. */
      readonly reviewedOn: string;
      /** Who accepted the risk. A team handle, not an individual. */
      readonly reviewedBy: string;
    }
  | {
      readonly status: "provisional";
      /** The issue tracking this partner's outstanding review. */
      readonly ticket: string;
      /** ISO date the exception was opened. */
      readonly since: string;
    }
  | {
      readonly status: "blocked";
      /** Why SDP must not reach this partner yet. Shown in no user-facing text. */
      readonly reason: string;
    }
  | {
      /**
       * Not a third party: SDP's own key material or endpoint behind a
       * provider-shaped interface. There is no counterparty to review, no DPA to
       * own, and no data leaving the deployment.
       */
      readonly status: "not_third_party";
      readonly reason: string;
    };

/** Where the credential SDP presents to the partner comes from. */
export type PartnerCredentialSource =
  /** Deployment-managed: Doppler for development and CI, GCP secret refs in production. */
  | "deployment"
  /** Supplied by the customer through provider setup, stored encrypted. */
  | "customer"
  /** Both paths exist for this partner. */
  | "both"
  /** No credential: a public endpoint. */
  | "none";

/** What the credential can do upstream if it is stolen. */
export type PartnerCredentialCapability =
  /** Nothing: there is no credential. */
  | "none"
  /** Reads only. */
  | "read"
  /** Creates and mutates partner-side records, but cannot move value. */
  | "read_write"
  /** Can sign, transfer, or instruct a payout. */
  | "value_moving";

export interface PartnerCredentialScope {
  /**
   * The env keys the API's availability definition actually reads for this
   * partner. `partner-intake.drift.test.ts` recovers them by probing
   * `isConfigured` and pins the result against this list, so "credential scope
   * was reviewed" is a checked claim rather than a note.
   */
  readonly envKeys: readonly string[];
  readonly source: PartnerCredentialSource;
  readonly capability: PartnerCredentialCapability;
}

/** What SDP does when the partner is down, slow, or answering nonsense. */
export type PartnerFailureBehavior =
  /** SDP refuses the operation. The caller sees a provider error, never a guess. */
  | "fail_closed"
  /** SDP moves the request to another provider in the same family. */
  | "failover"
  /** SDP serves its own last-known state and the partner's absence is invisible. */
  | "degraded_read";

export interface PartnerRetention {
  /**
   * What SDP keeps about the exchange after it completes. A subset of the data
   * map — you cannot retain what you never received.
   */
  readonly sdpStores: readonly PartnerDataCategory[];
  /**
   * The partner's documented retention period, or `null` when no DPA answer
   * exists. `null` is only allowed while clearance is `provisional`.
   */
  readonly partnerPeriod: string | null;
}

/** The levers that stop data reaching a partner, in the order operators reach for them. */
export type PartnerDisablementLever =
  /** Flip this register's clearance to `blocked`; refuses at the availability gate. */
  | "intake_clearance"
  /** Per-organization `providerOverrides`; commercial, not a security control. */
  | "provider_overrides"
  /** `EARN_PROVIDER_SURFACING`; stops new positions without touching existing ones. */
  | "earn_surfacing"
  /** Clear the credential env keys; stops all traffic and cannot be overridden. */
  | "remove_credentials";

export interface PartnerDisablement {
  /** Ordered from reversible to blunt. Every partner supports `intake_clearance`. */
  readonly levers: readonly PartnerDisablementLever[];
  /**
   * Whether disabling the partner can leave customer value unreachable.
   *
   * `true` demands an exit path before the switch is thrown — the reason the
   * Earn withdrawal routes deliberately bypass every admission gate (ADR 0002).
   */
  readonly canStrandValue: boolean;
}

/** Who owns the data-processing agreement, and whether one is needed. */
export type PartnerDpa =
  | { readonly status: "executed"; readonly owner: string; readonly reference: string }
  | { readonly status: "not_required"; readonly reason: string }
  /** No DPA answer has been recorded. Only valid while clearance is `provisional`. */
  | { readonly status: "unrecorded" };

/**
 * How caller-supplied personal data reaches the partner.
 *
 * This is the SDP-018 half of the record, and the distinction is the whole
 * control. A payload assembled field-by-field from a declared requirement spec
 * cannot carry a field nobody declared. A payload forwarded as an object can,
 * because `collectedData` at the API boundary is an open `Record<string, string>`
 * — so those payloads must pass an enforced allowlist before they leave.
 */
export type PartnerPersonalDataEgress =
  /** No natural-person data reaches this partner. */
  | "none"
  /** Built field-by-field from a declared requirement spec; the spec is the allowlist. */
  | "constructed"
  /** Forwarded wholesale; `personalDataFieldAllowlist` is enforced at the client. */
  | "allowlisted_bag";

export interface PartnerIntakeRecord {
  /** The accountable team. A handle that can be paged, not a person who may leave. */
  readonly owner: string;
  readonly clearance: PartnerClearance;
  /** Everything that crosses the boundary in either direction. */
  readonly dataMap: readonly PartnerDataCategory[];
  readonly personalDataEgress: PartnerPersonalDataEgress;
  /**
   * Dotted field paths permitted in a forwarded personal-data payload.
   *
   * Non-empty exactly when `personalDataEgress` is `allowlisted_bag`; enforced by
   * `minimizePartnerPersonalData` in @sdp/payments, which refuses the request
   * rather than silently dropping a field, so an undeclared field is caught in
   * review instead of leaking on the first production call.
   */
  readonly personalDataFieldAllowlist: readonly string[];
  readonly retention: PartnerRetention;
  readonly disablement: PartnerDisablement;
  readonly credentialScope: PartnerCredentialScope;
  readonly failureBehavior: PartnerFailureBehavior;
  readonly dpa: PartnerDpa;
}

type PartnerIntakeRegistry = {
  [Family in PartnerFamily]: Record<PartnerIdByFamily[Family], PartnerIntakeRecord>;
};

/**
 * Owner of record for every partner that predates the register.
 *
 * The repository's `CODEOWNERS` team, which is the truthful answer today: no
 * partner has a narrower owner assigned. Clearing a partner means replacing this
 * with the team that actually carries the integration.
 */
const MAINTAINERS = "@solana-foundation/sdp-maintainers";

/** The issue that opened the register, and the date it did. */
const INTAKE_TICKET = "HOO-1003";
const INTAKE_OPENED_ON = "2026-08-29";

/**
 * A dated exception for an integration that shipped before the gate existed.
 *
 * Every use is one line of technical debt with an owner and a ticket, counted by
 * `partner-intake.drift.test.ts`.
 */
function provisional(): PartnerClearance {
  return { status: "provisional", ticket: INTAKE_TICKET, since: INTAKE_OPENED_ON };
}

/**
 * What every custody partner receives.
 *
 * Custody sees SDP's own labels, the addresses it provisions, and the
 * transactions it is asked to sign — never counterparty identity, which lives
 * entirely in the ramps family. `canStrandValue` is true across the board: a
 * custody provider holds the keys, so removing it strands every wallet under it.
 */
const CUSTODY_BASELINE = {
  owner: MAINTAINERS,
  dataMap: ["organization_identity", "wallet_address", "transaction", "provider_reference"],
  personalDataEgress: "none",
  personalDataFieldAllowlist: [],
  retention: {
    sdpStores: ["organization_identity", "wallet_address", "transaction", "provider_reference"],
    partnerPeriod: null,
  },
  disablement: {
    levers: ["intake_clearance", "provider_overrides", "remove_credentials"],
    canStrandValue: true,
  },
  failureBehavior: "fail_closed",
  dpa: { status: "unrecorded" },
} as const satisfies Omit<PartnerIntakeRecord, "clearance" | "credentialScope">;

/**
 * What every RPC partner receives.
 *
 * Addresses and signed transactions, which is a privacy exposure rather than a
 * custody one — an RPC endpoint learns which addresses a deployment watches and
 * what it broadcasts, and cannot alter either. Nothing is stranded by removing
 * one because the relay falls back to another target.
 */
const RPC_BASELINE = {
  owner: MAINTAINERS,
  dataMap: ["wallet_address", "transaction"],
  personalDataEgress: "none",
  personalDataFieldAllowlist: [],
  retention: { sdpStores: [], partnerPeriod: null },
  disablement: {
    levers: ["intake_clearance", "provider_overrides", "remove_credentials"],
    canStrandValue: false,
  },
  failureBehavior: "failover",
  dpa: { status: "unrecorded" },
} as const satisfies Omit<PartnerIntakeRecord, "clearance" | "credentialScope">;

/**
 * What every compliance partner receives: one Solana address per screening call.
 *
 * No name, no identifier, no amount — `screenAddress` sends the address and
 * nothing else. The credential reads a risk verdict and cannot mutate anything,
 * which is why this family carries the smallest blast radius in the register.
 */
const COMPLIANCE_BASELINE = {
  owner: MAINTAINERS,
  dataMap: ["wallet_address"],
  personalDataEgress: "none",
  personalDataFieldAllowlist: [],
  retention: { sdpStores: ["wallet_address"], partnerPeriod: null },
  disablement: {
    levers: ["intake_clearance", "provider_overrides", "remove_credentials"],
    canStrandValue: false,
  },
  failureBehavior: "fail_closed",
  dpa: { status: "unrecorded" },
} as const satisfies Omit<PartnerIntakeRecord, "clearance" | "credentialScope">;

/**
 * What every ramp partner receives — the family the intake exists for.
 *
 * Ramps are the only place a natural person's identity, government id and bank
 * details leave SDP. Since #1507 SDP itself stores none of it: the counterparty
 * row keeps provider references and the transfer keeps its economics, while the
 * identity fields are collected just-in-time and forwarded without being
 * persisted. That is why `sdpStores` is so much smaller than `dataMap` here, and
 * why it must stay that way.
 *
 * `canStrandValue` is true because a transfer in flight settles through the
 * partner; disabling one mid-flight needs those transfers drained first.
 */
const RAMP_BASELINE = {
  owner: MAINTAINERS,
  dataMap: [
    "counterparty_identity",
    "government_id",
    "contact",
    "bank_account",
    "wallet_address",
    "transaction",
    "provider_reference",
  ],
  personalDataEgress: "constructed",
  personalDataFieldAllowlist: [],
  retention: {
    sdpStores: ["wallet_address", "transaction", "provider_reference"],
    partnerPeriod: null,
  },
  disablement: {
    levers: ["intake_clearance", "provider_overrides", "remove_credentials"],
    canStrandValue: true,
  },
  failureBehavior: "fail_closed",
  dpa: { status: "unrecorded" },
} as const satisfies Omit<PartnerIntakeRecord, "clearance" | "credentialScope">;

/**
 * What every Earn partner receives: addresses and amounts, never identity.
 *
 * `earn_surfacing` leads the disablement levers because it is the one that
 * respects ADR 0002's exit-safety invariant — it closes the way in and leaves
 * every read, re-target and withdrawal route working.
 */
const EARN_BASELINE = {
  owner: MAINTAINERS,
  dataMap: ["wallet_address", "transaction", "provider_reference"],
  personalDataEgress: "none",
  personalDataFieldAllowlist: [],
  retention: {
    sdpStores: ["wallet_address", "transaction", "provider_reference"],
    partnerPeriod: null,
  },
  disablement: {
    levers: ["earn_surfacing", "intake_clearance", "provider_overrides", "remove_credentials"],
    canStrandValue: false,
  },
  failureBehavior: "fail_closed",
  dpa: { status: "unrecorded" },
} as const satisfies Omit<PartnerIntakeRecord, "clearance" | "credentialScope">;

/**
 * The exact personal fields BVNK's `individual` payload may carry.
 *
 * Recovered from `buildBvnkIndividualPayload` as it stood before #1507 removed
 * stored counterparty PII, so this is the set the integration actually sent
 * rather than a wish list. BVNK customer creation is currently unreachable —
 * the handler refuses it until just-in-time collection is wired — and this
 * allowlist is what that rewiring has to satisfy: `createBvnkCustomer` refuses a
 * payload carrying anything not listed here.
 *
 * Nested fields use dotted paths. Nothing here is optional-by-omission: a field
 * absent from a given payload is fine, a field present but unlisted is not.
 */
export const BVNK_INDIVIDUAL_FIELD_ALLOWLIST = [
  "description",
  "firstName",
  "lastName",
  "dateOfBirth",
  "emailAddress",
  "nationality",
  "birthCountryCode",
  "taxIdentification.number",
  "taxIdentification.taxResidenceCountryCode",
  "address.addressLine1",
  "address.addressLine2",
  "address.city",
  "address.postalCode",
  "address.countryCode",
  "address.stateCode",
  "cdd.employmentStatus",
  "cdd.sourceOfFunds",
  "cdd.pepStatus",
  "cdd.intendedUseOfAccount",
  "cdd.expectedMonthlyVolume.amount",
  "cdd.expectedMonthlyVolume.currency",
  "cdd.estimatedYearlyIncome",
  "cdd.employmentIndustrySector",
] as const;

export const PARTNER_INTAKE = {
  custody: {
    local: {
      ...CUSTODY_BASELINE,
      clearance: {
        status: "not_third_party",
        reason: "SDP's own signer for self-hosted deployments; no data leaves the deployment.",
      },
      credentialScope: {
        envKeys: ["CUSTODY_PRIVATE_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
      retention: { sdpStores: CUSTODY_BASELINE.retention.sdpStores, partnerPeriod: "n/a" },
      dpa: { status: "not_required", reason: "No third party receives data." },
    },
    fireblocks: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["FIREBLOCKS_API_KEY", "FIREBLOCKS_API_SECRET"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    privy: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["PRIVY_APP_ID", "PRIVY_APP_SECRET"],
        // The one custody provider with self-service setup: an organization can
        // install its own Privy app credentials alongside the deployment pair.
        source: "both",
        capability: "value_moving",
      },
    },
    coinbase_cdp: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: [
          "COINBASE_CDP_API_KEY_ID",
          "COINBASE_CDP_API_KEY_SECRET",
          "COINBASE_CDP_WALLET_SECRET",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
    para: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["PARA_API_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    turnkey: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY", "TURNKEY_ORGANIZATION_ID"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    dfns: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["DFNS_AUTH_TOKEN", "DFNS_CREDENTIAL_ID", "DFNS_PRIVATE_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    ibm_haven: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["IBM_HAVEN_AUTH_TOKEN", "IBM_HAVEN_CREDENTIAL_ID", "IBM_HAVEN_PRIVATE_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    anchorage: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["ANCHORAGE_API_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    utila: {
      ...CUSTODY_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: [
          "UTILA_SERVICE_ACCOUNT_EMAIL",
          "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
          "UTILA_VAULT_ID",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
  },
  rpc: {
    default: {
      ...RPC_BASELINE,
      // Not `not_third_party`: SOLANA_RPC_URL is whatever endpoint the deployment
      // points at, which is usually somebody's commercial RPC. The register
      // cannot name the operator, so it records the exposure and leaves the
      // review outstanding rather than pretending there is nobody upstream.
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_URL"],
        source: "deployment",
        capability: "read_write",
      },
    },
    alchemy: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_ALCHEMY_URL"],
        source: "both",
        capability: "read_write",
      },
    },
    helius: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_HELIUS_URL"],
        source: "both",
        capability: "read_write",
      },
    },
    nodit: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_NODIT_URL"],
        source: "both",
        capability: "read_write",
      },
    },
    quicknode: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_QUICKNODE_URL"],
        source: "both",
        capability: "read_write",
      },
    },
    triton: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_TRITON_URL"],
        source: "both",
        capability: "read_write",
      },
    },
    validationcloud: {
      ...RPC_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["SOLANA_RPC_VALIDATIONCLOUD_URL"],
        source: "both",
        capability: "read_write",
      },
    },
  },
  compliance: {
    range: {
      ...COMPLIANCE_BASELINE,
      clearance: provisional(),
      credentialScope: { envKeys: ["RANGE_API_KEY"], source: "deployment", capability: "read" },
    },
    elliptic: {
      ...COMPLIANCE_BASELINE,
      clearance: provisional(),
      credentialScope: {
        // Two accepted shapes: a single token, or the key/secret pair.
        envKeys: ["ELLIPTIC_API_TOKEN", "ELLIPTIC_API_KEY", "ELLIPTIC_API_SECRET"],
        source: "deployment",
        capability: "read",
      },
    },
    trm: {
      ...COMPLIANCE_BASELINE,
      clearance: provisional(),
      credentialScope: { envKeys: ["TRM_API_KEY"], source: "deployment", capability: "read" },
    },
    chainalysis: {
      ...COMPLIANCE_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["CHAINALYSIS_API_KEY"],
        source: "deployment",
        capability: "read",
      },
    },
  },
  ramps: {
    moonpay: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: [
          "MOONPAY_API_KEY",
          "MOONPAY_SECRET_KEY",
          "MOONPAY_SANDBOX_API_KEY",
          "MOONPAY_SANDBOX_SECRET_KEY",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
    lightspark: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: [
          "LIGHTSPARK_GRID_CLIENT_ID",
          "LIGHTSPARK_GRID_CLIENT_SECRET",
          "LIGHTSPARK_GRID_SANDBOX_CLIENT_ID",
          "LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
    bvnk: {
      ...RAMP_BASELINE,
      // The reason the register exists in this shape. BVNK is the only
      // integration that forwards an object of identity fields wholesale, and
      // the only one whose customer creation is still unbuilt — so it is the one
      // partner the gate must actually stop today.
      clearance: {
        status: "blocked",
        reason:
          "Draft integration. Customer creation is unimplemented pending just-in-time identity collection, and no security or data-handling review has been completed for the identity fields it would forward.",
      },
      personalDataEgress: "allowlisted_bag",
      personalDataFieldAllowlist: BVNK_INDIVIDUAL_FIELD_ALLOWLIST,
      credentialScope: {
        envKeys: [
          "BVNK_WALLET_ID",
          "BVNK_HAWK_AUTH_ID",
          "BVNK_HAWK_SECRET_KEY",
          "BVNK_SANDBOX_WALLET_ID",
          "BVNK_SANDBOX_HAWK_AUTH_ID",
          "BVNK_SANDBOX_HAWK_SECRET_KEY",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
    moneygram: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        // Sandbox only: the availability definition refuses production outright.
        envKeys: ["MONEYGRAM_SANDBOX_PUBLIC_KEY", "MONEYGRAM_SANDBOX_SECRET_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    coinbase: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        // Shares the account-wide CDP key with the custody provider of the same
        // account: one credential, two partners' worth of blast radius.
        envKeys: ["COINBASE_CDP_API_KEY_ID", "COINBASE_CDP_API_KEY_SECRET"],
        source: "deployment",
        capability: "value_moving",
      },
    },
    mural: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: [
          "MURAL_PAY_API_KEY",
          "MURAL_PAY_TRANSFER_API_KEY",
          "MURAL_PAY_SANDBOX_API_KEY",
          "MURAL_PAY_SANDBOX_TRANSFER_API_KEY",
        ],
        source: "deployment",
        capability: "value_moving",
      },
    },
    stripe: {
      ...RAMP_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
        source: "deployment",
        capability: "value_moving",
      },
    },
  },
  earn: {
    veda: {
      ...EARN_BASELINE,
      clearance: {
        status: "blocked",
        reason:
          "Registered for catalogue-sync consistency but never implemented; the client throws NOT_IMPLEMENTED and no review has been done.",
      },
      credentialScope: {
        envKeys: ["VEDA_API_KEY", "VEDA_SANDBOX_API_KEY"],
        source: "deployment",
        capability: "read",
      },
    },
    upshift: {
      ...EARN_BASELINE,
      clearance: {
        status: "blocked",
        reason:
          "Registered for catalogue-sync consistency but never implemented; the client throws NOT_IMPLEMENTED and no review has been done.",
      },
      credentialScope: {
        envKeys: ["UPSHIFT_API_KEY", "UPSHIFT_SANDBOX_API_KEY"],
        source: "deployment",
        capability: "read",
      },
    },
    perena: {
      ...EARN_BASELINE,
      clearance: {
        status: "blocked",
        reason:
          "Registered for catalogue-sync consistency but never implemented; the client throws NOT_IMPLEMENTED and no review has been done.",
      },
      credentialScope: {
        envKeys: ["PERENA_API_KEY", "PERENA_SANDBOX_API_KEY"],
        source: "deployment",
        capability: "read",
      },
    },
    ground: {
      ...EARN_BASELINE,
      clearance: provisional(),
      credentialScope: {
        envKeys: ["GROUND_API_KEY", "GROUND_SANDBOX_API_KEY"],
        source: "deployment",
        capability: "value_moving",
      },
      disablement: {
        levers: EARN_BASELINE.disablement.levers,
        // Custodial: Ground fronts an omnibus wallet SDP provisions and funds.
        // An organization holding a Ground program reaches its balance only
        // through Ground, so nothing here may block a withdrawal route.
        canStrandValue: true,
      },
    },
    kamino: {
      ...EARN_BASELINE,
      clearance: provisional(),
      credentialScope: { envKeys: [], source: "none", capability: "none" },
      dpa: {
        status: "not_required",
        reason:
          "Public catalogue reads only: no credential and no personal data leave SDP, and deposits move from the customer's own wallet on-chain.",
      },
    },
  },
} as const satisfies PartnerIntakeRegistry;

/** The intake record for a registered partner. */
export function partnerIntakeRecord<Family extends PartnerFamily>(
  family: Family,
  providerId: PartnerIdByFamily[Family]
): PartnerIntakeRecord {
  return (PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord>)[providerId];
}

/**
 * Whether the intake permits SDP to reach this partner at all.
 *
 * Fails closed for an id that is not in the register, which can only happen when
 * an id arrives from an open read model rather than from a registered union.
 */
export function isPartnerIntakeCleared(family: PartnerFamily, providerId: string): boolean {
  const record = (PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord | undefined>)[
    providerId
  ];
  return record !== undefined && record.clearance.status !== "blocked";
}

/**
 * The enforced allowlist for a partner that forwards personal data wholesale, or
 * `undefined` when it does not do that — which is not the same as "the empty
 * allowlist", and callers must not treat it as such.
 */
export function partnerPersonalDataAllowlist(
  family: PartnerFamily,
  providerId: string
): readonly string[] | undefined {
  const record = (PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord | undefined>)[
    providerId
  ];
  return record?.personalDataEgress === "allowlisted_bag"
    ? record.personalDataFieldAllowlist
    : undefined;
}

/** Every partner whose review is still outstanding, for the drift guard and the doc. */
export function partnersAwaitingIntakeReview(): { family: PartnerFamily; providerId: string }[] {
  const familyIds: { [Family in PartnerFamily]: readonly string[] } = {
    custody: CUSTODY_PROVIDERS,
    rpc: ORGANIZATION_RPC_PROVIDERS,
    compliance: COMPLIANCE_PROVIDERS,
    ramps: RAMP_PROVIDERS,
    earn: EARN_PROVIDERS,
  };

  return PARTNER_FAMILIES.flatMap((family) =>
    familyIds[family]
      .filter((providerId) => {
        const record = (PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord>)[providerId];
        return record.clearance.status === "provisional";
      })
      .map((providerId) => ({ family, providerId }))
  );
}
