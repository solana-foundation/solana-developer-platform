import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  EARN_PROVIDERS,
  ORGANIZATION_RPC_PROVIDERS,
  PARTNER_FAMILIES,
  PARTNER_INTAKE,
  PARTNER_PERSONAL_DATA_CATEGORIES,
  type PartnerFamily,
  type PartnerIntakeRecord,
  partnersAwaitingIntakeReview,
  RAMP_PROVIDERS,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import {
  assertPartnerIntakeCleared,
  PROVIDER_AVAILABILITY_DEFINITIONS,
} from "./provider-availability.service";

const repoRoot = join(process.cwd(), "..", "..");
const INTAKE_DOC = join(repoRoot, "docs", "security", "partner-security-intake.md");

const PARTNER_IDS: { [Family in PartnerFamily]: readonly string[] } = {
  custody: CUSTODY_PROVIDERS,
  rpc: ORGANIZATION_RPC_PROVIDERS,
  compliance: COMPLIANCE_PROVIDERS,
  ramps: RAMP_PROVIDERS,
  earn: EARN_PROVIDERS,
};

function everyPartner(): {
  family: PartnerFamily;
  providerId: string;
  record: PartnerIntakeRecord;
}[] {
  return PARTNER_FAMILIES.flatMap((family) =>
    PARTNER_IDS[family].map((providerId) => ({
      family,
      providerId,
      record: (PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord>)[providerId],
    }))
  );
}

/**
 * Env keys an availability definition actually consults, recovered by running
 * its `isConfigured` against a recording proxy.
 *
 * Probing beats a second hand-written list. The keys live inside closures, and
 * a declaration next to them would be one more thing to forget — the exact
 * failure this guard exists to catch. `credentialEnvKeys` stays declared only
 * for the earn family, where the existing drift guard uses it to check env
 * projections that sit outside the type system.
 *
 * Branches are reached by iteration rather than by reading the source: the first
 * pass returns a value for every key, which satisfies whichever branch comes
 * first (usually production); the next pass forces every key found so far to
 * empty, so the fallback branch (usually sandbox, or Elliptic's key/secret pair)
 * evaluates in turn. It repeats until a pass finds nothing new. `testMode` is
 * swept because MoneyGram returns before reading anything when asked for
 * production.
 */
const NON_CREDENTIAL_ENV_KEYS = new Set(["SDP_DEPLOYMENT_MODE"]);

function envKeysRead(isConfigured: (env: Env, testMode?: boolean) => boolean): Set<string> {
  const seen = new Set<string>();
  let forcedEmpty = new Set<string>();

  for (let round = 0; round < 8; round += 1) {
    const before = seen.size;

    for (const testMode of [undefined, true, false]) {
      const probe = new Proxy(
        {},
        {
          get(_target, property) {
            const key = String(property);
            seen.add(key);
            // A mode switch, not a credential: answer it truthfully so the
            // self-hosted branch of the `local` custody definition is reachable.
            if (key === "SDP_DEPLOYMENT_MODE") return "self_hosted";
            return forcedEmpty.has(key) ? "" : "probe-value";
          },
        }
      );
      isConfigured(probe as Env, testMode);
    }

    if (seen.size === before) break;
    forcedEmpty = new Set(seen);
  }

  for (const key of NON_CREDENTIAL_ENV_KEYS) {
    seen.delete(key);
  }
  return seen;
}

describe("partner intake register completeness", () => {
  it("holds a record for every registered partner in every family", () => {
    const missing = everyPartner()
      .filter(({ record }) => record === undefined)
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(missing).toEqual([]);
  });

  it("names an accountable owner for every partner", () => {
    const unowned = everyPartner()
      .filter(({ record }) => record.owner.trim().length === 0)
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(unowned).toEqual([]);
  });

  it("offers the intake clearance itself as a disablement lever everywhere", () => {
    const missing = everyPartner()
      .filter(({ record }) => !record.disablement.levers.includes("intake_clearance"))
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(missing).toEqual([]);
  });

  /** Surfacing is an Earn-only switch; claiming it elsewhere would be a lever that does not exist. */
  it("claims the earn surfacing lever only for earn partners", () => {
    const wrong = everyPartner()
      .filter(
        ({ family, record }) =>
          family !== "earn" && record.disablement.levers.includes("earn_surfacing")
      )
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(wrong).toEqual([]);
  });

  it("never retains a category it does not receive", () => {
    const impossible = everyPartner()
      .filter(({ record }) =>
        record.retention.sdpStores.some((category) => !record.dataMap.includes(category))
      )
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(impossible).toEqual([]);
  });
});

describe("partner intake credential scope", () => {
  /**
   * The claim behind "credential scope is reviewed": the keys recorded in the
   * register are exactly the keys the deployment hands the partner. A key added
   * to an availability check without being recorded here is an unreviewed
   * credential, which is the thing the intake is supposed to notice.
   */
  it("records exactly the env keys each availability definition reads", () => {
    const mismatches: string[] = [];

    for (const family of PARTNER_FAMILIES) {
      const definitions = PROVIDER_AVAILABILITY_DEFINITIONS[family] as Record<
        string,
        { isConfigured: (env: Env, testMode?: boolean) => boolean }
      >;

      for (const providerId of PARTNER_IDS[family]) {
        const actual = [...envKeysRead(definitions[providerId].isConfigured)].sort();
        const recorded = [
          ...(PARTNER_INTAKE[family] as Record<string, PartnerIntakeRecord>)[providerId]
            .credentialScope.envKeys,
        ].sort();

        if (JSON.stringify(actual) !== JSON.stringify(recorded)) {
          mismatches.push(
            `${family}:${providerId} reads [${actual.join(", ")}] but records [${recorded.join(", ")}]`
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("declares no credential only for partners reached without one", () => {
    const keyless = everyPartner()
      .filter(({ record }) => record.credentialScope.envKeys.length === 0)
      .map(({ family, providerId, record }) => ({
        id: `${family}:${providerId}`,
        source: record.credentialScope.source,
        capability: record.credentialScope.capability,
      }));

    // Kamino's vault data API is public; it is the only partner SDP reaches
    // with nothing, and both fields have to say so.
    expect(keyless).toEqual([{ id: "earn:kamino", source: "none", capability: "none" }]);
  });
});

describe("partner intake PII minimization", () => {
  it("carries an allowlist exactly when a payload is forwarded wholesale", () => {
    const inconsistent = everyPartner()
      .filter(({ record }) => {
        const hasAllowlist = record.personalDataFieldAllowlist.length > 0;
        return hasAllowlist !== (record.personalDataEgress === "allowlisted_bag");
      })
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(inconsistent).toEqual([]);
  });

  /**
   * A partner that receives no personal data must not claim a personal-data
   * egress mode, and a partner that does receive it must not claim `none`.
   * Either direction would leave the register describing a different system
   * from the one running.
   */
  it("matches the declared egress mode to the data map", () => {
    const inconsistent = everyPartner()
      .filter(({ record }) => {
        const receivesPersonalData = record.dataMap.some((category) =>
          (PARTNER_PERSONAL_DATA_CATEGORIES as readonly string[]).includes(category)
        );
        return receivesPersonalData === (record.personalDataEgress === "none");
      })
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(inconsistent).toEqual([]);
  });

  it("uses dotted paths with no leading, trailing or empty segments", () => {
    const malformed = everyPartner().flatMap(({ family, providerId, record }) =>
      record.personalDataFieldAllowlist
        .filter((path) => path.split(".").some((segment) => segment.trim().length === 0))
        .map((path) => `${family}:${providerId} ${path}`)
    );

    expect(malformed).toEqual([]);
  });
});

describe("partner intake clearance", () => {
  /**
   * The ratchet. `provisional` records the integrations that predate the gate:
   * their answers were derived from code, nobody reviewed the partner, and no
   * DPA ownership exists. The list may shrink as partners are cleared and must
   * never grow — a new partner starts `blocked` and becomes `cleared`, and
   * adding an id here instead is how a gate quietly stops being one.
   */
  const PROVISIONAL_BASELINE = [
    "compliance:chainalysis",
    "compliance:elliptic",
    "compliance:range",
    "compliance:trm",
    "custody:anchorage",
    "custody:coinbase_cdp",
    "custody:dfns",
    "custody:fireblocks",
    "custody:ibm_haven",
    "custody:para",
    "custody:privy",
    "custody:turnkey",
    "custody:utila",
    "earn:ground",
    "earn:kamino",
    "ramps:coinbase",
    "ramps:lightspark",
    "ramps:moneygram",
    "ramps:moonpay",
    "ramps:mural",
    "ramps:stripe",
    "rpc:alchemy",
    "rpc:default",
    "rpc:helius",
    "rpc:nodit",
    "rpc:quicknode",
    "rpc:triton",
    "rpc:validationcloud",
  ];

  it("adds no partner to the provisional exception list", () => {
    const current = partnersAwaitingIntakeReview()
      .map(({ family, providerId }) => `${family}:${providerId}`)
      .sort();
    const added = current.filter((id) => !PROVISIONAL_BASELINE.includes(id));

    expect(added).toEqual([]);
  });

  /**
   * Fails when a partner is cleared without the baseline being trimmed. Loud on
   * purpose: the doc's outstanding-review table is checked against this same
   * list, so leaving a stale entry would leave the doc wrong too.
   */
  it("keeps the provisional baseline trimmed to what is still outstanding", () => {
    const current = partnersAwaitingIntakeReview()
      .map(({ family, providerId }) => `${family}:${providerId}`)
      .sort();

    expect(current).toEqual(PROVISIONAL_BASELINE);
  });

  it("records DPA ownership and a partner retention period for every cleared partner", () => {
    const incomplete = everyPartner()
      .filter(
        ({ record }) =>
          record.clearance.status === "cleared" &&
          (record.dpa.status === "unrecorded" || record.retention.partnerPeriod === null)
      )
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(incomplete).toEqual([]);
  });

  /**
   * The other side of the same rule. An unanswered DPA or retention question is
   * tolerable under a dated exception, and moot for a blocked partner nothing
   * reaches — but a partner declared "not a third party" is claiming there is no
   * counterparty at all, so it owes a positive answer rather than a silence.
   */
  it("answers DPA and retention outright for partners declared not a third party", () => {
    const unexplained = everyPartner()
      .filter(({ record }) => {
        if (record.clearance.status !== "not_third_party") return false;
        return record.dpa.status === "unrecorded" || record.retention.partnerPeriod === null;
      })
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(unexplained).toEqual([]);
  });

  it("gives every provisional exception a ticket and a date", () => {
    const untracked = everyPartner()
      .filter(
        ({ record }) =>
          record.clearance.status === "provisional" &&
          (record.clearance.ticket.trim().length === 0 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(record.clearance.since))
      )
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(untracked).toEqual([]);
  });

  it("explains every block", () => {
    const unexplained = everyPartner()
      .filter(
        ({ record }) =>
          record.clearance.status === "blocked" && record.clearance.reason.trim().length === 0
      )
      .map(({ family, providerId }) => `${family}:${providerId}`);

    expect(unexplained).toEqual([]);
  });
});

describe("assertPartnerIntakeCleared", () => {
  /**
   * The acceptance criterion this whole change exists for: draft BVNK and the
   * unimplemented Earn providers cannot reach production, however complete
   * their credentials are.
   */
  it("refuses the draft BVNK integration", () => {
    expect(() => assertPartnerIntakeCleared("ramps", "bvnk")).toThrowError(AppError);
    expect(() => assertPartnerIntakeCleared("ramps", "bvnk")).toThrowError(
      /partner security intake/
    );
  });

  it.each(["veda", "upshift", "perena"])("refuses the unimplemented earn provider %s", (id) => {
    expect(() => assertPartnerIntakeCleared("earn", id)).toThrowError(AppError);
  });

  it("allows partners the register clears or provisionally excepts", () => {
    expect(() => assertPartnerIntakeCleared("earn", "kamino")).not.toThrow();
    expect(() => assertPartnerIntakeCleared("ramps", "moonpay")).not.toThrow();
    expect(() => assertPartnerIntakeCleared("custody", "local")).not.toThrow();
  });

  /** Ids can arrive from open database read models; an unknown one is not a pass. */
  it("fails closed for an id that is not registered", () => {
    expect(() => assertPartnerIntakeCleared("ramps", "not-a-provider")).toThrowError(AppError);
  });
});

describe("partner intake documentation", () => {
  /**
   * The doc is the human half of the control, and a table of outstanding
   * reviews is worthless the moment it stops matching the register. Parsed
   * rather than eyeballed for the same reason the module map is generated.
   */
  it("lists exactly the partners still awaiting review", () => {
    const doc = readFileSync(INTAKE_DOC, "utf8");
    const section = doc.split("## Outstanding reviews")[1]?.split("\n## ")[0];
    expect(section, "the outstanding-reviews section is missing").toBeDefined();

    const documented = [...(section ?? "").matchAll(/^\| `([a-z]+):([a-z0-9_]+)` \|/gm)]
      .map((match) => `${match[1]}:${match[2]}`)
      .sort();
    const outstanding = partnersAwaitingIntakeReview()
      .map(({ family, providerId }) => `${family}:${providerId}`)
      .sort();

    expect(documented).toEqual(outstanding);
  });
});
