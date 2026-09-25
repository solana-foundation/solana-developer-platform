import type { ComplianceProviderId } from "./provider-access";

/**
 * Provider-neutral verdict vocabulary for address-screening results
 * (SOLA9-160 / APE-722).
 *
 * Every compliance provider answers in its own words — numeric scores here,
 * free-text labels there, and a documented "no risk found" shape per provider.
 * Substring-matching those words at the point of display is what let an
 * `ok` result with a null score and an unrecognized label (e.g. `"unknown"`)
 * read as a clean `neutral` screening and auto-commit into a custody
 * destination allowlist. Verdicts are therefore resolved once, explicitly:
 *
 *  - `pass`         — a recognized completed screening that found nothing
 *                     (e.g. Elliptic's null canonical score or not-in-blockchain
 *                     completion, TRM's no-attribution response).
 *  - `low`/`medium`/`high` — a recognized risk band, from the numeric score
 *                     when present, else the risk label.
 *  - `unrecognized` — no usable score and a label outside the vocabulary, or
 *                     no verdict at all. NOT a clean result: consumers must
 *                     treat it as review-required and adapters must not
 *                     report it as `status: "ok"`.
 */
export const COMPLIANCE_VERDICTS = ["pass", "low", "medium", "high", "unrecognized"] as const;
export type ComplianceVerdict = (typeof COMPLIANCE_VERDICTS)[number];

/**
 * Recognized risk-level labels per band. Matched exactly (after trimming and
 * lowercasing) on purpose: a label outside these sets is contract drift, and
 * drifting to `unrecognized` fails closed while substring matching drifted to
 * the nearest clean tone.
 */
const HIGH_RISK_LEVELS = new Set(["severe", "high", "critical", "elevated"]);
const MEDIUM_RISK_LEVELS = new Set(["medium", "moderate", "watch"]);
const LOW_RISK_LEVELS = new Set(["low", "very low", "none", "minimal"]);

/**
 * Providers whose documented "no score, no label" response is itself a
 * completed clean verdict. For every other provider a screening without a
 * usable verdict is unreadable, not clean.
 */
const NULL_SCORE_COMPLETION_BY_PROVIDER: Record<ComplianceProviderId, boolean> = {
  elliptic: true,
  trm: true,
  range: false,
  chainalysis: false,
};

/** Completed clean-check phrases, per provider. */
const PASS_LEVELS_BY_PROVIDER: Record<ComplianceProviderId, Set<string>> = {
  elliptic: new Set(["check passed"]),
  trm: new Set(),
  range: new Set(),
  chainalysis: new Set(),
};

/**
 * Score thresholds shared by every consumer that bands numeric risk scores:
 * `>= 7` is high, `>= 3` is medium, otherwise low.
 */
export const COMPLIANCE_RISK_SCORE_THRESHOLDS = { high: 7, medium: 3 } as const;

export interface ComplianceVerdictInput {
  provider: ComplianceProviderId;
  riskScore: number | null;
  riskLevel?: string;
}

/**
 * Resolves a normalized screening result to the provider-neutral verdict it
 * carries. The numeric score wins over the label when both are present;
 * a label is matched exactly against the recognized vocabulary; anything
 * else — an unknown label, an empty label without a recognized completion
 * shape — is `unrecognized` and must never read as clean.
 */
export function resolveComplianceVerdict(input: ComplianceVerdictInput): ComplianceVerdict {
  if (typeof input.riskScore === "number" && Number.isFinite(input.riskScore)) {
    if (input.riskScore >= COMPLIANCE_RISK_SCORE_THRESHOLDS.high) {
      return "high";
    }
    if (input.riskScore >= COMPLIANCE_RISK_SCORE_THRESHOLDS.medium) {
      return "medium";
    }
    return "low";
  }

  const level = input.riskLevel?.trim().toLowerCase() ?? "";
  if (!level) {
    return NULL_SCORE_COMPLETION_BY_PROVIDER[input.provider] ? "pass" : "unrecognized";
  }
  if (HIGH_RISK_LEVELS.has(level)) {
    return "high";
  }
  if (MEDIUM_RISK_LEVELS.has(level)) {
    return "medium";
  }
  if (LOW_RISK_LEVELS.has(level)) {
    return "low";
  }
  if (PASS_LEVELS_BY_PROVIDER[input.provider]?.has(level)) {
    return "pass";
  }
  return "unrecognized";
}
