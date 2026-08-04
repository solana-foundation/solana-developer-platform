/**
 * Seeds realistic issued tokens + asset profiles into a local database, so the
 * issuance workspace has enough data to exercise search, filters, sorting and
 * paging.
 *
 * Every row is validated against the same schemas the API enforces before it is
 * written (createTokenSchema, issuanceMetadataSchema, the asset-type registry and
 * the advanced-settings catalog), and public_metadata is produced by the same
 * projection the write path uses — so seeded assets behave exactly like ones
 * created through the UI.
 *
 * Every asset is a DRAFT. Deploying is what creates a mint, its authorities and a
 * circulating supply, and only a real deploy against a cluster can do that — a
 * fabricated mint address would point at an account that exists nowhere, breaking
 * explorer links, supply refresh and every admin action. To get active/paused
 * assets, deploy a few drafts from the UI against your local validator or devnet.
 *
 * Deterministic: the same `--seed` always produces the same catalogue. Idempotent:
 * every seeded row is stamped `created_by = 'seed:issuance-demo'` and re-running
 * replaces exactly those rows, never anything you created yourself.
 *
 *   pnpm -C apps/sdp-api db:seed:issuance                    # 60 assets
 *   pnpm -C apps/sdp-api db:seed:issuance -- --count 200
 *   pnpm -C apps/sdp-api db:seed:issuance -- --clean         # remove them again
 *   pnpm -C apps/sdp-api db:seed:issuance -- --project prj_x
 */

import { randomUUID } from "node:crypto";
import {
  ADVANCED_SETTINGS_VERSION,
  validateSelectedSettings,
  validateSettingParams,
} from "@sdp/issuance/capabilities";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { type AssetCategory, getAssetTypeRegistryEntry, isAssetTypeSupported } from "@sdp/types";
import pg from "pg";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { issuanceMetadataSchema } from "@/routes/asset-profiles/schemas";
import { createTokenSchema } from "@/routes/issuance/schemas";

const SEED_MARKER = "seed:issuance-demo";
const ICON_BASE = "https://api.iconify.design/noto";
const DEFAULT_COUNT = 60;
const DEFAULT_SEED = 20260728;

// ── Deterministic randomness ────────────────────────────────────────────────
// Seeded so a given --seed always yields the same catalogue: bug reports stay
// reproducible and screenshots don't churn between runs.

function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function pickSome<T>(random: Random, values: readonly T[], max: number): T[] {
  const pool = [...values];
  const take = Math.floor(random() * (max + 1));
  const chosen: T[] = [];
  for (let index = 0; index < take && pool.length > 0; index += 1) {
    chosen.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return chosen;
}

function chance(random: Random, probability: number): boolean {
  return random() < probability;
}

function integer(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// No address generator here on purpose: every Solana address these rows reference
// (signing wallet, permanent delegate) is read from custody_wallets, so the seed
// can never claim an account that doesn't exist.

/**
 * Whole tokens → the base units the column stores. The read path formats it back
 * with the token's decimals, so writing whole tokens directly would render as a
 * fraction of a token.
 */
function toBaseUnits(wholeTokens: string, decimals: number): string {
  return parseDecimalAmount(wholeTokens, decimals).toString();
}

// ── Asset catalogue ─────────────────────────────────────────────────────────
// One entry per (category, type) pair in the registry, each with its own name
// pools, icons and type-specific metadata so a fund never reads like a
// stablecoin. Names are fictional issuers in the style of real ones.

interface AssetKind {
  category: AssetCategory;
  type: string;
  /** Token template stored on the row; must stay plausible for the category. */
  template: "stablecoin" | "tokenized-security" | "arcade" | "custom";
  icons: readonly string[];
  decimals: readonly number[];
  /** [name, symbol] pairs. */
  assets: ReadonlyArray<readonly [string, string]>;
  issuers: readonly string[];
  descriptions: readonly string[];
  /** Type-specific `asset.*` metadata. */
  detail: (random: Random, issuer: string) => Record<string, unknown>;
}

const US_EU_UK_SG = ["us", "eu", "uk", "sg", "other"] as const;
const OFFERINGS = ["reg_d", "reg_s", "reg_a", "public", "other"] as const;
const SENIORITY = [
  "senior_secured",
  "senior_unsecured",
  "subordinated",
  "mezzanine",
  "unsecured",
] as const;
const FUND_STRATEGIES = ["money_market", "fixed_income", "equity", "multi_asset", "other"] as const;
const PROPERTY_TYPES = [
  "residential",
  "commercial",
  "industrial",
  "land",
  "mixed_use",
  "other",
] as const;
const CUSTODIANS = [
  "Northlake Trust",
  "Harborstone Custody",
  "Meridian Trust Company",
  "Cedar & Vale Custodians",
  "Anchor Bay Trust",
];
const ORACLES = ["Pyth Network", "Switchboard", "Chainlink", "RedStone"];
const AUDITORS = ["Vance & Roe LLP", "Kestrel Assurance", "Bramble Audit Group"];

function website(issuer: string): string {
  const host = issuer
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 22);
  return `https://${host || "example"}.example.com`;
}

function documents(random: Random, issuer: string, kinds: readonly string[]): unknown[] {
  return pickSome(random, kinds, 3).map((docType) => ({
    type: docType,
    name: `${issuer} ${docType.replace(/_/g, " ")}`,
    url: `${website(issuer)}/docs/${docType}.pdf`,
  }));
}

const ASSET_KINDS: readonly AssetKind[] = [
  {
    category: "stablecoin",
    type: "fiat_backed",
    template: "stablecoin",
    icons: ["dollar-banknote", "euro-banknote", "pound-banknote", "coin", "bank", "credit-card"],
    decimals: [2, 6],
    assets: [
      ["Northlake USD", "nUSD"],
      ["Harborstone Dollar", "hUSD"],
      ["Meridian Euro", "mEUR"],
      ["Cedar Sterling", "cGBP"],
      ["Anchor Bay Dollar", "abUSD"],
      ["Solstice USD", "sUSD"],
      ["Lantern Franc", "lCHF"],
      ["Kestrel Yen", "kJPY"],
      ["Vale Dollar", "vUSD"],
      ["Beacon Singapore Dollar", "bSGD"],
    ],
    issuers: [
      "Northlake Financial Inc.",
      "Harborstone Payments Ltd.",
      "Meridian Issuance SA",
      "Cedar & Vale Financial",
      "Anchor Bay Digital",
    ],
    descriptions: [
      "Fully reserved payment token redeemable 1:1 for cash held in segregated accounts at regulated banks.",
      "Fiat-backed settlement token for treasury operations, with monthly attestations of the reserve pool.",
      "Regulated e-money token used for cross-border payouts and merchant settlement.",
    ],
    detail: (random, issuer) => {
      const currency = pick(random, ["USD", "EUR", "GBP", "CHF", "JPY", "SGD"]);
      return {
        backingType: "fiat",
        pegCurrency: currency,
        pegTarget: `1.00 ${currency}`,
        reserveAsset: pick(random, [
          "Cash and cash equivalents",
          "Short-dated treasury bills",
          "Overnight reverse repos",
          "Bank deposits and T-bills",
        ]),
        reserveCustodian: pick(random, CUSTODIANS),
        redemptionEnabled: chance(random, 0.8) ? true : undefined,
        jurisdiction: pick(random, US_EU_UK_SG),
        documents: documents(random, issuer, [
          "attestation",
          "terms_of_service",
          "reserve_report",
          "audit",
        ]),
      };
    },
  },
  {
    category: "stablecoin",
    type: "crypto_backed",
    template: "stablecoin",
    icons: ["coin", "money-bag", "balance-scale", "locked", "shield"],
    decimals: [6, 8],
    assets: [
      ["Basalt Dollar", "bUSD"],
      ["Overcollateral USD", "ocUSD"],
      ["Ridgeline Dollar", "rUSD"],
      ["Vault Anchor USD", "vaUSD"],
      ["Keystone Dollar", "ksUSD"],
      ["Solvent Euro", "svEUR"],
    ],
    issuers: ["Basalt Protocol Foundation", "Ridgeline Labs", "Keystone Collective", "Solvent DAO"],
    descriptions: [
      "Overcollateralized stable asset backed by on-chain collateral with transparent liquidation parameters.",
      "Crypto-collateralized unit of account; collateral ratio and oracle feeds are published on-chain.",
      "Decentralized stable asset with a hard floor maintained by a surplus buffer and keeper auctions.",
    ],
    detail: (random) => {
      const currency = pick(random, ["USD", "EUR"]);
      return {
        backingType: "crypto",
        pegCurrency: currency,
        pegTarget: `1.00 ${currency}`,
        reserveAsset: pick(random, [
          "SOL, mSOL",
          "SOL, JitoSOL, USDC",
          "wBTC, SOL",
          "Diversified LST basket",
        ]),
        collateralizationRatio: pick(random, ["150", "165", "175", "200"]),
        minCollateralRatio: pick(random, ["120", "130", "140"]),
        oracleProvider: pick(random, ORACLES),
        redemptionEnabled: chance(random, 0.6) ? true : undefined,
      };
    },
  },
  {
    category: "stablecoin",
    type: "generic",
    template: "stablecoin",
    icons: ["coin", "credit-card", "receipt"],
    decimals: [2, 6],
    assets: [
      ["Transit Credit", "TRNC"],
      ["Merchant Settlement Unit", "MSU"],
      ["Payroll Dollar", "PYUSD"],
      ["Campus Credit", "CMPC"],
    ],
    issuers: ["Transit Systems Group", "Merchant Rails Ltd.", "Campus Services Co."],
    descriptions: [
      "Closed-loop credit used inside a partner network; stable in unit terms and redeemable for services.",
      "Internal settlement unit for platform payouts, pegged for accounting simplicity.",
    ],
    detail: (random) => ({
      pegCurrency: pick(random, ["USD", "EUR"]),
      redemptionEnabled: chance(random, 0.5) ? true : undefined,
    }),
  },
  {
    category: "tokenized_security",
    type: "equity",
    template: "tokenized-security",
    icons: ["chart-increasing", "office-building", "briefcase", "classical-building"],
    decimals: [0, 2],
    assets: [
      ["Alder Robotics Series B", "ALDRB"],
      ["Pinecrest Health Equity", "PNCH"],
      ["Vertex Marine Holdings", "VRTXM"],
      ["Quarry Materials Co.", "QRRY"],
      ["Lumen Grid Energy", "LMNG"],
      ["Foundry Works Equity", "FNDRY"],
    ],
    issuers: [
      "Alder Robotics Inc.",
      "Pinecrest Health Group",
      "Vertex Marine Holdings plc",
      "Lumen Grid Energy SA",
    ],
    descriptions: [
      "Tokenized common equity representing a fractional shareholding, transferable only between verified holders.",
      "Private company shares issued under an exemption, with transfer restrictions enforced on-chain.",
      "Digital share class carrying economic rights and voting through a nominee structure.",
    ],
    detail: (random, issuer) => ({
      jurisdiction: pick(random, US_EU_UK_SG),
      offeringType: pick(random, OFFERINGS),
      shareClass: pick(random, ["Class A", "Class B", "Series B Preferred", "Ordinary"]),
      votingRights: chance(random, 0.5) ? true : undefined,
      custodian: pick(random, CUSTODIANS),
      documents: documents(random, issuer, [
        "offering_memorandum",
        "subscription_agreement",
        "cap_table",
        "audit",
      ]),
    }),
  },
  {
    category: "tokenized_security",
    type: "debt",
    template: "tokenized-security",
    icons: ["scroll", "ledger", "bank", "page-facing-up"],
    decimals: [0, 2, 6],
    assets: [
      ["Harbor 2029 Senior Note", "HRB29"],
      ["Cedar Infrastructure Bond", "CEDIB"],
      ["Kestrel Trade Receivables", "KSTRR"],
      ["Meridian 2027 Fixed Note", "MER27"],
      ["Ironwood Green Bond", "IRNGB"],
      ["Solstice Bridge Loan", "SOLBL"],
    ],
    issuers: [
      "Harbor Capital Partners",
      "Cedar Infrastructure Finance",
      "Kestrel Trade Finance Ltd.",
      "Ironwood Sustainable Credit",
    ],
    descriptions: [
      "Senior secured note paying a fixed coupon, with principal repaid at maturity to holders of record.",
      "Tokenized private credit exposure to short-duration trade receivables, reported monthly.",
      "Use-of-proceeds green bond financing grid upgrades, with an annual impact report.",
    ],
    detail: (random, issuer) => {
      const year = integer(random, 2027, 2033);
      return {
        jurisdiction: pick(random, US_EU_UK_SG),
        offeringType: pick(random, OFFERINGS),
        couponRate: `${integer(random, 3, 11)}.${integer(random, 0, 9)}%`,
        maturityDate: `${year}-${String(integer(random, 1, 12)).padStart(2, "0")}-15`,
        seniority: pick(random, SENIORITY),
        custodian: pick(random, CUSTODIANS),
        documents: documents(random, issuer, [
          "offering_memorandum",
          "indenture",
          "rating_letter",
          "audit",
        ]),
      };
    },
  },
  {
    category: "tokenized_security",
    type: "fund",
    template: "tokenized-security",
    icons: ["bar-chart", "briefcase", "balance-scale", "chart-increasing"],
    decimals: [2, 6],
    assets: [
      ["Northlake Treasury Fund", "NLTF"],
      ["Harborstone Money Market", "HSMM"],
      ["Meridian Global Equity Fund", "MGEF"],
      ["Cedar Multi-Asset Fund", "CDMA"],
      ["Beacon Short Duration Fund", "BSDF"],
      ["Lantern Income Fund", "LTIF"],
      ["Vale Balanced Fund", "VLBF"],
    ],
    issuers: [
      "Northlake Asset Management",
      "Harborstone Investments",
      "Meridian Fund Managers",
      "Beacon Capital Advisors",
    ],
    descriptions: [
      "Tokenized share class of a regulated fund, with NAV published each business day.",
      "Money market strategy holding short-dated government paper; subscriptions settle T+0 on-chain.",
      "Diversified multi-asset fund wrapper offering intraday transferability between eligible investors.",
    ],
    detail: (random, issuer) => ({
      jurisdiction: pick(random, US_EU_UK_SG),
      offeringType: pick(random, OFFERINGS),
      fundStrategy: pick(random, FUND_STRATEGIES),
      managementFee: `0.${integer(random, 1, 9)}${integer(random, 0, 9)}%`,
      netAssetValue: `${integer(random, 1, 250)}.${integer(random, 10, 99)}`,
      custodian: pick(random, CUSTODIANS),
      documents: documents(random, issuer, ["prospectus", "kiid", "annual_report", "audit"]),
    }),
  },
  {
    category: "tokenized_security",
    type: "generic",
    template: "tokenized-security",
    icons: ["page-facing-up", "briefcase", "classical-building"],
    decimals: [0, 2],
    assets: [
      ["Structured Note 2031", "SN31"],
      ["Revenue Share Certificate", "RSC"],
      ["Royalty Participation Unit", "RPU"],
      ["Carbon Credit Forward", "CCF"],
    ],
    issuers: ["Aperture Structured Products", "Rill Royalty Partners", "Grove Carbon Markets"],
    descriptions: [
      "Structured instrument whose payoff tracks a reference basket, held only by verified investors.",
      "Certificate entitling the holder to a share of contracted revenue, distributed quarterly.",
    ],
    detail: (random) => ({
      jurisdiction: pick(random, US_EU_UK_SG),
      offeringType: pick(random, OFFERINGS),
      underlyingAsset: pick(random, [
        "S&P 500 index",
        "Contracted SaaS revenue",
        "Music catalogue royalties",
        "Verified carbon units",
      ]),
    }),
  },
  {
    category: "generic",
    type: "commodity",
    template: "custom",
    icons: ["coin", "oil-drum", "fuel-pump", "gem-stone", "ear-of-corn", "sheaf-of-rice", "cow"],
    decimals: [6, 8, 9],
    assets: [
      ["Vaulted Gold Ounce", "vXAU"],
      ["Silver Vault Token", "vXAG"],
      ["Copper Warrant Token", "CUWT"],
      ["West Texas Barrel Token", "WTBT"],
      ["Sunfield Wheat Token", "SFWT"],
      ["Highland Cattle Unit", "HCUT"],
      ["Platinum Vault Unit", "vXPT"],
    ],
    issuers: [
      "Northlake Metals Custody",
      "Harborstone Commodities",
      "Sunfield Agricultural Group",
      "Highland Producers Co-op",
    ],
    descriptions: [
      "Each token represents one troy ounce held in an insured, audited vault and redeemable on request.",
      "Warehouse-receipt token for graded physical inventory, with quarterly independent inspection.",
      "Delivery-settled commodity unit backed by warehouse receipts from accredited storage partners.",
    ],
    detail: (random, issuer) => ({
      underlyingAsset: pick(random, [
        "1 troy oz gold, LBMA good delivery",
        "1 troy oz silver",
        "1 tonne Grade A copper",
        "1 barrel WTI crude",
        "1 bushel No.2 soft red winter wheat",
      ]),
      custodian: pick(random, CUSTODIANS),
      redemptionEnabled: chance(random, 0.7) ? true : undefined,
      documents: documents(random, issuer, ["assay_report", "vault_attestation", "insurance"]),
    }),
  },
  {
    category: "generic",
    type: "real_estate",
    template: "custom",
    icons: ["house", "office-building", "factory", "classical-building", "palm-tree"],
    decimals: [0, 2, 6],
    assets: [
      ["Riverside Lofts Unit", "RVSL"],
      ["Dockside Logistics Park", "DKLP"],
      ["Aspen Ridge Residences", "ASPR"],
      ["Market Street Retail", "MKSR"],
      ["Cedar Business Campus", "CDBC"],
      ["Palm Harbour Resort", "PLHR"],
    ],
    issuers: [
      "Riverside Property Trust",
      "Dockside Industrial REIT",
      "Aspen Ridge Developments",
      "Cedar Estates Group",
    ],
    descriptions: [
      "Fractional interest in a stabilized income-producing property, with rent distributed monthly.",
      "Tokenized SPV interest in a logistics park let to investment-grade tenants on long leases.",
      "Fractionalized residential portfolio managed by a licensed operator; NAV updated quarterly.",
    ],
    detail: (random, issuer) => ({
      propertyType: pick(random, PROPERTY_TYPES),
      propertyLocation: pick(random, [
        "Austin, TX, United States",
        "Rotterdam, Netherlands",
        "Manchester, United Kingdom",
        "Lisbon, Portugal",
        "Singapore",
        "Denver, CO, United States",
      ]),
      custodian: pick(random, CUSTODIANS),
      documents: documents(random, issuer, ["valuation", "title_report", "lease_summary", "audit"]),
    }),
  },
  {
    category: "generic",
    type: "collectible",
    template: "arcade",
    icons: [
      "framed-picture",
      "artist-palette",
      "violin",
      "trophy",
      "admission-tickets",
      "film-frames",
      "soccer-ball",
    ],
    decimals: [0],
    assets: [
      ["Gallery Row Print Pass", "GRPP"],
      ["Vintage Vinyl Vault", "VVLT"],
      ["Stadium Season Pass", "STSP"],
      ["Festival Access Token", "FSTA"],
      ["Studio Reel Collection", "SRLC"],
      ["Championship Trophy Share", "CHTS"],
    ],
    issuers: [
      "Gallery Row Collective",
      "Vinyl Vault Archive",
      "Stadium Holdings Ltd.",
      "Studio Reel Foundation",
    ],
    descriptions: [
      "Membership token granting access to a curated collection and priority on new releases.",
      "Redeemable collectible pass tied to physical items held by the issuing archive.",
      "Season access token with transferable resale rights inside the partner marketplace.",
    ],
    detail: (random) => ({
      underlyingAsset: pick(random, [
        "Limited-edition print series",
        "First-press vinyl archive",
        "Season ticket allocation",
        "Original 35mm reels",
      ]),
      redemptionEnabled: chance(random, 0.4) ? true : undefined,
    }),
  },
  {
    category: "generic",
    type: "generic",
    template: "custom",
    icons: ["gear", "robot", "rocket", "seedling", "high-voltage", "water-wave", "sun", "dna"],
    decimals: [0, 6, 9],
    assets: [
      ["Grid Capacity Credit", "GRDC"],
      ["Compute Hour Token", "CMPH"],
      ["Reforestation Credit", "RFST"],
      ["Desalination Unit", "DSAL"],
      ["Research Grant Unit", "RGU"],
      ["Launch Manifest Slot", "LMS"],
      ["Loyalty Points Unit", "LOYP"],
    ],
    issuers: [
      "Lumen Grid Energy SA",
      "Northwind Compute",
      "Grove Environmental Trust",
      "Blue Aquifer Works",
    ],
    descriptions: [
      "Utility credit redeemable against metered capacity on the issuer's network.",
      "Prepaid compute entitlement, transferable between accounts within the partner programme.",
      "Verified environmental credit retired on the holder's behalf when claimed.",
    ],
    detail: (random) => ({
      underlyingAsset: pick(random, [
        "1 MWh dispatchable capacity",
        "1 GPU-hour, A100 class",
        "1 tonne CO2e sequestered",
        "1,000 litres potable water",
      ]),
      redemptionEnabled: chance(random, 0.5) ? true : undefined,
    }),
  },
];

// ── Compliance + settings ───────────────────────────────────────────────────

const CAPACITY_KEYS = [
  "kyc",
  "issueRetireControls",
  "restrictTradingHours",
  "redemptionApprovals",
  "investorReporting",
  "transferApprovals",
] as const;

function buildCapacities(random: Random, kind: AssetKind): Record<string, unknown> {
  // Regulated instruments lean heavily on off-chain policy; utility tokens rarely
  // enable any. Presence = enabled, matching the wizard's encoding.
  const weight =
    kind.category === "tokenized_security" ? 0.62 : kind.category === "stablecoin" ? 0.4 : 0.22;
  const capacities: Record<string, unknown> = {};

  for (const key of CAPACITY_KEYS) {
    if (!chance(random, weight)) {
      continue;
    }
    capacities[key] = { enabled: true };
  }

  // Configure a subset of the configurable ones — an enabled-but-unconfigured
  // policy is a real state too (it shows up as a readiness item), so leave some.
  if (capacities.restrictTradingHours && chance(random, 0.7)) {
    const schedule = pick(random, ["24_7", "market_hours", "custom"] as const);
    capacities.restrictTradingHours = {
      enabled: true,
      config:
        schedule === "custom"
          ? {
              schedule,
              days: ["mon", "tue", "wed", "thu", "fri"],
              open: "09:30",
              close: "16:00",
              timezone: pick(random, [
                "America/New_York",
                "Europe/London",
                "Europe/Zurich",
                "Asia/Singapore",
                "Asia/Tokyo",
                "UTC",
              ]),
            }
          : { schedule },
    };
  }

  if (capacities.transferApprovals && chance(random, 0.7)) {
    const rule = pick(random, ["all", "above_amount", "new_counterparty"] as const);
    capacities.transferApprovals = {
      enabled: true,
      config: {
        rule,
        ...(rule === "above_amount"
          ? { amount: String(pick(random, [10_000, 50_000, 100_000, 250_000])) }
          : {}),
        approvers: [],
      },
    };
  }

  if (capacities.redemptionApprovals && chance(random, 0.7)) {
    const rule = pick(random, ["all", "above_amount"] as const);
    capacities.redemptionApprovals = {
      enabled: true,
      config: {
        rule,
        ...(rule === "above_amount"
          ? { amount: String(pick(random, [25_000, 100_000, 500_000])) }
          : {}),
        approvers: [],
      },
    };
  }

  if (capacities.investorReporting && chance(random, 0.7)) {
    capacities.investorReporting = {
      enabled: true,
      config: {
        cadence: pick(random, ["monthly", "quarterly", "annual"] as const),
        format: pick(random, ["pdf", "csv", "xlsx"] as const),
        recipients: [],
      },
    };
  }

  return capacities;
}

interface SettingsSelection {
  /** `issuance_metadata.settings`, or undefined when nothing is selected. */
  settings?: { version: number; selected: Record<string, { params?: Record<string, string> }> };
  /** Matching `issued_token_extensions` rows: extension → JSON config or null. */
  extensions: Array<{ extension: string; config: string | null }>;
}

/**
 * Advanced (Token-2022) settings, plus the extension rows that must agree with
 * them. Selections are validated against the catalog before they are written, and
 * the two conflicting families are never combined.
 *
 * All of this is pre-deploy configuration — the extension rows a draft legitimately
 * carries from template resolution, exactly like the ones on a token created
 * through the wizard. Nothing here implies on-chain state.
 */
function buildSettings(
  random: Random,
  kind: AssetKind,
  requiresAllowlist: boolean,
  signerPublicKey: string | null
): SettingsSelection {
  const selected: Record<string, { params?: Record<string, string> }> = {};
  const extensions: SettingsSelection["extensions"] = [];

  if (chance(random, 0.45)) {
    // Pausing the mint and freezing individual accounts are separate settings;
    // only the former maps to an extension.
    selected.pauseTransfers = {};
    selected.freezeAccounts = {};
    extensions.push({ extension: "pausable", config: null });
  }
  // The permanent delegate is a real key or nothing: it names the account that
  // would hold seize/force-burn rights, so inventing an address would be a claim
  // about a wallet that doesn't exist.
  if (signerPublicKey && chance(random, 0.5)) {
    selected.permanentDelegate = {};
    extensions.push({ extension: "permanentDelegate", config: JSON.stringify(signerPublicKey) });
  }
  if (chance(random, 0.3)) {
    const basisPoints = pick(random, [5, 10, 25, 50, 100]);
    selected.transferFee = { params: { basisPoints: String(basisPoints), maxFee: "0" } };
    extensions.push({
      extension: "transferFee",
      config: JSON.stringify({ basisPoints, maxFee: "0" }),
    });
  } else if (chance(random, 0.25)) {
    // interestBearing conflicts with scaledUiAmount; pick at most one.
    const rate = integer(random, 25, 750);
    selected.interestBearing = { params: { rate: String(rate) } };
    extensions.push({ extension: "interestBearing", config: JSON.stringify({ rate }) });
  }

  // Template resolution sets the default account state at create time: gated
  // assets mint frozen so holders must be thawed through the control list.
  extensions.push({
    extension: "defaultAccountState",
    config: JSON.stringify(requiresAllowlist ? "frozen" : "initialized"),
  });

  const keys = Object.keys(selected);
  const keyErrors = validateSelectedSettings(kind.category, kind.type, keys);
  if (keyErrors.length > 0) {
    // A catalog/registry change made a pairing invalid — drop it rather than write
    // something the API would reject.
    for (const { settingKey } of keyErrors) {
      delete selected[settingKey];
    }
  }
  const paramErrors = validateSettingParams(selected);
  if (paramErrors.length > 0) {
    throw new Error(
      `Generated invalid advanced-setting params: ${paramErrors
        .map((error) => `${error.settingKey}.${error.paramKey} (${error.reason})`)
        .join(", ")}`
    );
  }

  return {
    settings:
      Object.keys(selected).length > 0
        ? { version: ADVANCED_SETTINGS_VERSION, selected }
        : undefined,
    extensions,
  };
}

// ── Row generation ──────────────────────────────────────────────────────────

interface SeedRow {
  token: {
    id: string;
    name: string;
    symbol: string;
    decimals: number;
    description: string;
    uri: string;
    imageUrl: string;
    template: string;
    /** Chosen signer for the eventual deploy; a real custody wallet id or none. */
    signingWalletId: string | null;
    maxSupply: string | null;
    isMintable: boolean;
    isFreezable: boolean;
    requiresAllowlist: boolean;
    createdAt: string;
  };
  profile: {
    id: string;
    category: AssetCategory;
    type: string;
    version: number;
    issuanceMetadata: Record<string, unknown>;
    publicMetadata: Record<string, unknown>;
  };
  extensions: Array<{ extension: string; config: string | null }>;
}

function isoAt(nowMs: number, daysAgo: number, random: Random): string {
  const jitterMs = Math.floor(random() * 86_400_000);
  return new Date(nowMs - daysAgo * 86_400_000 - jitterMs).toISOString();
}

interface Identity {
  name: string;
  symbol: string;
  issuer: string;
  description: string;
}

/**
 * Names are unique without looking generated: repeats of the same base asset get
 * a series suffix, which also gives search a set of shared-prefix matches to work
 * against.
 */
function buildIdentity(random: Random, kind: AssetKind, index: number): Identity {
  const [baseName, baseSymbol] = pick(random, kind.assets);
  const series = Math.floor(index / ASSET_KINDS.length);
  const suffix = ["II", "III", "IV", "V", "VI"][series - 1] ?? `S${series}`;
  return {
    name: series === 0 ? baseName : `${baseName} ${suffix}`,
    symbol: series === 0 ? baseSymbol : `${baseSymbol}${series + 1}`.slice(0, 10),
    issuer: pick(random, kind.issuers),
    description: pick(random, kind.descriptions),
  };
}

/**
 * Nothing here is deployed, so every asset is a draft: `status = 'pending'` with
 * no mint, no authorities and no deploy timestamp. Inventing a mint address would
 * be a claim about an account that exists on no cluster — explorer links would
 * dead-end and every admin action would fail against it. Deploying is what
 * creates that state, and only a real deploy can.
 *
 * Creation dates span ~19 months so the 7d / 30d / 12m filters all have something
 * to find, with the first few rows deliberately inside the last week.
 */
function buildCreatedAt(random: Random, index: number, nowMs: number): string {
  const daysAgo = index < 3 ? integer(random, 0, 6) : integer(random, 7, 580);
  return isoAt(nowMs, daysAgo, random);
}

/**
 * Max supply is a pre-deploy configuration choice, so a draft can carry one.
 * Circulating supply cannot: nothing has been minted, so it is always zero.
 */
function buildMaxSupplyWhole(random: Random): string | null {
  return chance(random, 0.65)
    ? String(pick(random, [1_000_000, 10_000_000, 100_000_000, 500_000_000, 1_000_000_000]))
    : null;
}

/** `asset.*`, pruned the way the wizard prunes empty values before saving. */
function buildAssetNamespace(
  random: Random,
  kind: AssetKind,
  identity: Identity
): Record<string, unknown> {
  const asset: Record<string, unknown> = {
    name: identity.name,
    description: identity.description,
    website: website(identity.issuer),
    issuerName: identity.issuer,
    ...kind.detail(random, identity.issuer),
  };

  for (const [key, value] of Object.entries(asset)) {
    const empty =
      value === undefined ||
      value === "" ||
      value === false ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      delete asset[key];
    }
  }

  return asset;
}

/** `compliance.*`: access-control mode plus the off-chain capacity selection. */
function buildComplianceNamespace(
  random: Random,
  kind: AssetKind,
  requiresAllowlist: boolean
): Record<string, unknown> {
  const compliance: Record<string, unknown> = {};
  // Keep the metadata's view of access control consistent with the token row's
  // allowlist flag, which is what the on-chain gate is built from.
  if (requiresAllowlist) {
    compliance.accessControl = "allowlist";
  } else if (chance(random, 0.15)) {
    compliance.accessControl = "blocklist";
  }

  const capacities = buildCapacities(random, kind);
  if (Object.keys(capacities).length > 0) {
    compliance.capacities = capacities;
  }
  return compliance;
}

/** `custom.customer.*`: the sort of internal bookkeeping issuers actually add. */
function buildCustomerNamespace(random: Random): Record<string, string> {
  const customer: Record<string, string> = {};
  if (chance(random, 0.5)) {
    customer.internalDeskId = `${pick(random, ["FX", "CR", "EQ", "CM"])}-${integer(random, 10, 99)}`;
  }
  if (chance(random, 0.35)) {
    customer.relationshipManager = pick(random, [
      "A. Okafor",
      "J. Lindqvist",
      "M. Duarte",
      "S. Chatterjee",
      "R. Nakamura",
    ]);
  }
  if (chance(random, 0.25)) {
    customer.auditor = pick(random, AUDITORS);
  }
  return customer;
}

interface SignerWallet {
  walletId: string;
  publicKey: string;
}

function buildRow(
  random: Random,
  index: number,
  nowMs: number,
  apiBaseUrl: string,
  signers: readonly SignerWallet[]
): SeedRow {
  const kind = ASSET_KINDS[index % ASSET_KINDS.length] as AssetKind;
  const registry = getAssetTypeRegistryEntry(kind.category, kind.type);
  if (!registry || !isAssetTypeSupported(kind.category, kind.type)) {
    throw new Error(`Unsupported category/type pair ${kind.category}/${kind.type}`);
  }

  const identity = buildIdentity(random, kind, index);
  const createdAt = buildCreatedAt(random, index, nowMs);
  const decimals = pick(random, kind.decimals);
  const requiresAllowlist =
    kind.category === "tokenized_security" ? chance(random, 0.8) : chance(random, 0.25);
  const maxSupplyWhole = buildMaxSupplyWhole(random);
  // Only ever a wallet that actually exists in this project — a draft with no
  // signer chosen yet is a perfectly normal state, so most get none.
  const signer = signers.length > 0 && chance(random, 0.5) ? pick(random, signers) : null;
  const settings = buildSettings(random, kind, requiresAllowlist, signer?.publicKey ?? null);
  const tokenId = `tok_${randomUUID()}`;

  const issuanceMetadata: Record<string, unknown> = {
    asset: buildAssetNamespace(random, kind, identity),
    chain: { decimals },
  };
  const compliance = buildComplianceNamespace(random, kind, requiresAllowlist);
  if (Object.keys(compliance).length > 0) {
    issuanceMetadata.compliance = compliance;
  }
  const customer = buildCustomerNamespace(random);
  if (Object.keys(customer).length > 0) {
    issuanceMetadata.custom = { customer };
  }
  if (settings.settings) {
    issuanceMetadata.settings = settings.settings;
  }
  // A minority publish a narrowed field set; the rest inherit the type's default
  // projection (no `visibility` key at all), like the wizard leaves it.
  if (chance(random, 0.2)) {
    issuanceMetadata.visibility = {
      public: registry.publicProjection.slice(0, Math.max(1, registry.publicProjection.length - 2)),
    };
  }

  const token: SeedRow["token"] = {
    id: tokenId,
    name: identity.name,
    symbol: identity.symbol,
    decimals,
    description: identity.description,
    uri: `${apiBaseUrl}/v1/issuance/tokens/${tokenId}/metadata.json`,
    imageUrl: `${ICON_BASE}/${pick(random, kind.icons)}.svg`,
    template: kind.template,
    signingWalletId: signer?.walletId ?? null,
    // Base units, as the column stores them; the API formats them back with
    // `decimals`. Circulating supply is absent because nothing has been minted.
    maxSupply: maxSupplyWhole ? toBaseUnits(maxSupplyWhole, decimals) : null,
    isMintable: chance(random, 0.8),
    isFreezable: chance(random, 0.7),
    requiresAllowlist,
    createdAt,
  };

  // Validate the token exactly as POST /v1/issuance/tokens would, in UI units.
  createTokenSchema.parse({
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    description: token.description,
    uri: token.uri,
    imageUrl: token.imageUrl,
    maxSupply: maxSupplyWhole ?? undefined,
    template: token.template,
    requiresAllowlist: token.requiresAllowlist,
    isMintable: token.isMintable,
    isFreezable: token.isFreezable,
  });

  const parsedMetadata = issuanceMetadataSchema.parse(issuanceMetadata);

  return {
    token,
    profile: {
      id: `ap_${randomUUID()}`,
      category: kind.category,
      type: kind.type,
      version: registry.version,
      issuanceMetadata: parsedMetadata as Record<string, unknown>,
      publicMetadata: projectPublicMetadata(kind.category, kind.type, parsedMetadata) as Record<
        string,
        unknown
      >,
    },
    extensions: settings.extensions,
  };
}

// ── Database ────────────────────────────────────────────────────────────────

interface ProjectScope {
  organizationId: string;
  projectId: string;
  projectName: string;
  organizationName: string;
}

async function resolveScope(
  client: pg.Client,
  requestedProjectId: string | undefined
): Promise<ProjectScope> {
  if (requestedProjectId) {
    const { rows } = await client.query(
      `SELECT p.id, p.name, p.organization_id, o.name AS org_name
         FROM projects p
         JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = $1`,
      [requestedProjectId]
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Project ${requestedProjectId} not found`);
    }
    return {
      organizationId: row.organization_id,
      projectId: row.id,
      projectName: row.name,
      organizationName: row.org_name,
    };
  }

  // Default to the project already holding the most tokens — the one being worked
  // in — falling back to the oldest sandbox project.
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.organization_id, o.name AS org_name,
            (SELECT COUNT(*) FROM issued_tokens t WHERE t.project_id = p.id) AS token_count
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
      WHERE p.status = 'active'
      ORDER BY token_count DESC,
               (p.environment = 'sandbox') DESC,
               p.created_at ASC
      LIMIT 1`
  );
  const row = rows[0];
  if (!row) {
    throw new Error("No active project found — run db:seed:local first.");
  }
  return {
    organizationId: row.organization_id,
    projectId: row.id,
    projectName: row.name,
    organizationName: row.org_name,
  };
}

/**
 * Active custody wallets in scope, so a seeded draft can name a signer that
 * actually exists. Empty is fine — a draft without a chosen signer is normal.
 */
async function loadSignerWallets(client: pg.Client, scope: ProjectScope): Promise<SignerWallet[]> {
  const { rows } = await client.query<{ wallet_id: string; public_key: string }>(
    `SELECT w.wallet_id, w.public_key
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
      WHERE w.status = 'active'
        AND c.organization_id = $1
        AND (c.project_id = $2 OR c.project_id IS NULL)
      ORDER BY w.created_at ASC`,
    [scope.organizationId, scope.projectId]
  );
  return rows.map((row) => ({ walletId: row.wallet_id, publicKey: row.public_key }));
}

async function deleteSeeded(client: pg.Client, projectId: string): Promise<number> {
  // asset_profiles and issued_token_extensions cascade from issued_tokens.
  const { rowCount } = await client.query(
    "DELETE FROM issued_tokens WHERE project_id = $1 AND created_by = $2",
    [projectId, SEED_MARKER]
  );
  return rowCount ?? 0;
}

async function insertRow(
  client: pg.Client,
  scope: ProjectScope,
  row: SeedRow,
  nowIso: string
): Promise<void> {
  const { token, profile } = row;
  // Deliberately omits mint_address, the authority columns, abl_list_address and
  // deployed_at: those describe on-chain state that only a real deploy creates.
  // The row is a draft, exactly as POST /v1/issuance/tokens leaves it.
  await client.query(
    `INSERT INTO issued_tokens (
       id, project_id, organization_id, name, symbol, decimals, description, uri, image_url,
       template, signing_wallet_id, total_supply_cached, total_supply_updated_at, max_supply,
       is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '0', $12, $13, $14, $15, $16,
       'pending', $17, $18, $19
     )`,
    [
      token.id,
      scope.projectId,
      scope.organizationId,
      token.name,
      token.symbol,
      token.decimals,
      token.description,
      token.uri,
      token.imageUrl,
      token.template,
      token.signingWalletId,
      token.createdAt,
      token.maxSupply,
      token.isMintable ? 1 : 0,
      token.isFreezable ? 1 : 0,
      token.requiresAllowlist ? 1 : 0,
      SEED_MARKER,
      token.createdAt,
      token.createdAt,
    ]
  );

  for (const extension of row.extensions) {
    await client.query(
      `INSERT INTO issued_token_extensions (id, token_id, extension, config, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [`ext_${randomUUID()}`, token.id, extension.extension, extension.config, token.createdAt]
    );
  }

  await client.query(
    `INSERT INTO asset_profiles (
       id, organization_id, project_id, token_id, asset_category, asset_type,
       asset_type_version, issuance_metadata, public_metadata, status, created_by,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'active', $10, $11, $12)`,
    [
      profile.id,
      scope.organizationId,
      scope.projectId,
      token.id,
      profile.category,
      profile.type,
      profile.version,
      JSON.stringify(profile.issuanceMetadata),
      JSON.stringify(profile.publicMetadata),
      SEED_MARKER,
      token.createdAt,
      nowIso,
    ]
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function summarize(rows: SeedRow[]): void {
  const byCategory = new Map<string, number>();
  const byTemplate = new Map<string, number>();
  let gated = 0;
  let withSigner = 0;
  let withSettings = 0;

  for (const { token, profile } of rows) {
    const pair = `${profile.category}/${profile.type}`;
    byCategory.set(pair, (byCategory.get(pair) ?? 0) + 1);
    byTemplate.set(token.template, (byTemplate.get(token.template) ?? 0) + 1);
    if (token.requiresAllowlist) gated += 1;
    if (token.signingWalletId) withSigner += 1;
    if (profile.issuanceMetadata.settings) withSettings += 1;
  }

  const format = (map: Map<string, number>) =>
    [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("  ");

  console.log(`  lifecycle : draft=${rows.length} (nothing is deployed on-chain)`);
  console.log(`  templates : ${format(byTemplate)}`);
  console.log(`  types     : ${format(byCategory)}`);
  console.log(
    `  config    : allowlist-gated=${gated}  signer-chosen=${withSigner}  advanced-settings=${withSettings}`
  );
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    // biome-ignore lint/security/noSecrets: local Docker Postgres default, same as the migrate scripts.
    "postgresql://sdp:sdp@127.0.0.1:5432/sdp";
  const cleanOnly = process.argv.includes("--clean");
  const count = Number(readFlag("count") ?? DEFAULT_COUNT);
  const seed = Number(readFlag("seed") ?? DEFAULT_SEED);
  const apiBaseUrl = (readFlag("api-base-url") ?? "http://localhost:8787").replace(/\/+$/, "");

  if (!Number.isInteger(count) || count < 1 || count > 5_000) {
    throw new Error("--count must be an integer between 1 and 5000");
  }
  if (!Number.isFinite(seed)) {
    throw new Error("--seed must be a number");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const scope = await resolveScope(client, readFlag("project"));
    console.log(`Target: ${scope.organizationName} → ${scope.projectName} (${scope.projectId})`);

    await client.query("BEGIN");
    const removed = await deleteSeeded(client, scope.projectId);
    if (removed > 0) {
      console.log(`Removed ${removed} previously seeded asset(s).`);
    }

    if (cleanOnly) {
      await client.query("COMMIT");
      console.log("Done — seeded demo assets removed.");
      return;
    }

    const signers = await loadSignerWallets(client, scope);
    const random = createRandom(seed);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows: SeedRow[] = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(buildRow(random, index, nowMs, apiBaseUrl, signers));
    }

    for (const row of rows) {
      await insertRow(client, scope, row, nowIso);
    }
    await client.query("COMMIT");

    const { rows: totals } = await client.query<{ count: string }>(
      "SELECT COUNT(*)::int AS count FROM issued_tokens WHERE project_id = $1",
      [scope.projectId]
    );
    console.log(`Inserted ${rows.length} asset(s) with profiles (seed ${seed}).`);
    summarize(rows);
    console.log(`  project now holds ${totals[0]?.count ?? "?"} asset(s) in total.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
