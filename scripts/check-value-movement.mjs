/**
 * Pins which API files may hold money authority (HOO-1955; see the money
 * admission ADR in docs/decisions).
 *
 * Sinks (custody signers, project sponsorship) only accept an
 * `AdmittedMovement`, so code that skips admission does not compile. What the
 * type system cannot say is *who* may mint a token, use the escape hatch, or
 * reach the raw constructors that predate the token. This check says it.
 *
 * It resolves every identifier with the TypeScript checker, so a reference
 * counts however it is spelled: `@/` alias or relative import, renamed import,
 * re-export, namespace access, or a value passed along. Any reference to a
 * capability from a file outside its allowlist fails. An allowlisted file that
 * no longer references its capability also fails, so the escape-hatch and raw
 * constructor lists can only shrink.
 *
 * Tests may reference any capability: they exercise them. Production code may
 * not reference the test minter at all.
 *
 * Adding a file to any list below is a security-reviewed change.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const API = "apps/sdp-api/src";

/** @typedef {{ file: string, name: string, member?: string }} CapabilitySymbol */
/**
 * @typedef {{
 *   id: string,
 *   why: string,
 *   symbols: CapabilitySymbol[],
 *   owners: string[],
 *   allow: string[],
 *   shrinkOnly?: boolean,
 * }} Capability
 */

/** @type {Capability[]} */
export const CAPABILITIES = [
  {
    id: "admit",
    why: "Minting a real token is deciding that money may move.",
    symbols: [{ file: `${API}/lib/admit-movement.ts`, name: "admitMovement" }],
    owners: [`${API}/lib/admit-movement.ts`],
    allow: [
      `${API}/middleware/movement.ts`,
      `${API}/routes/pay.ts`,
      `${API}/services/jobs/collect-recurring-payments.ts`,
    ],
  },
  {
    id: "legacy-hatch",
    why: "Mints without refusing, for modules whose admission has not landed.",
    symbols: [{ file: `${API}/lib/admit-movement.ts`, name: "uncheckedLegacyMovement" }],
    owners: [`${API}/lib/admit-movement.ts`],
    allow: [
      `${API}/routes/custody/handlers/approval-requests.ts`,
      `${API}/routes/earn/handlers/vault.ts`,
      `${API}/routes/issuance/handlers/authority-resolution.ts`,
      `${API}/services/dvp/create.ts`,
      `${API}/services/dvp/fund.ts`,
      `${API}/services/dvp/reclaim.ts`,
      `${API}/services/dvp/settle.ts`,
      `${API}/services/earn/vault-intent-execution.service.ts`,
      `${API}/services/earn/vault-queued-withdraw.service.ts`,
      `${API}/services/earn/vault-sponsorship.ts`,
      `${API}/services/helius-rings/signer-adapter.ts`,
      `${API}/services/private-channels/wallet-access.ts`,
    ],
    shrinkOnly: true,
  },
  {
    id: "test-mint",
    why: "Mints anything; Vitest only.",
    symbols: [{ file: `${API}/lib/admit-movement.ts`, name: "mintAdmittedMovementForTests" }],
    owners: [`${API}/lib/admit-movement.ts`],
    allow: [],
  },
  {
    id: "raw-sponsorship",
    why: "Sponsorship that takes no token; each caller moves to a token-taking sink in its slice.",
    symbols: [
      { file: `${API}/services/sponsorship.service.ts`, name: "createSponsorshipFeePayment" },
      {
        file: `${API}/services/sponsorship.service.ts`,
        // biome-ignore lint/security/noSecrets: a function name, not a secret.
        name: "createRequestSponsorshipFeePayment",
      },
      {
        file: `${API}/services/sponsorship.service.ts`,
        // biome-ignore lint/security/noSecrets: a function name, not a secret.
        name: "createAuthenticatedSponsorshipFeePayment",
      },
      {
        file: `${API}/services/sponsorship.service.ts`,
        name: "createUnscopedSponsorshipFeePayment",
      },
    ],
    owners: [`${API}/services/sponsorship.service.ts`],
    allow: [
      `${API}/routes/custody/handlers/signer-check.ts`,
      `${API}/routes/payments/context.ts`,
      `${API}/services/dvp/settle.ts`,
      `${API}/services/issuance/mosaic/index.ts`,
      `${API}/services/solana/factory.ts`,
    ],
    shrinkOnly: true,
  },
  {
    id: "raw-signer",
    why: "Signer acquisition below the token-taking factories.",
    symbols: [
      {
        file: `${API}/services/domain/signing/custody-runtime-target.ts`,
        name: "CustodyRuntimeTargets",
        member: "getTransactionSigner",
      },
      {
        file: `${API}/services/domain/signing/custody-runtime-target.ts`,
        name: "CustodyRuntimeTargets",
        member: "getTransactionSignerForWalletRecord",
      },
      {
        file: `${API}/services/domain/signing.service.ts`,
        name: "SigningService",
        member: "getTransactionSigner",
      },
      {
        file: `${API}/services/domain/signing.service.ts`,
        name: "SigningService",
        member: "getTransactionSignerForWalletRecord",
      },
    ],
    owners: [
      `${API}/services/domain/signing/custody-runtime-target.ts`,
      `${API}/services/domain/signing.service.ts`,
    ],
    allow: [`${API}/services/solana/signer.ts`],
  },
];

function isTestFile(relativePath) {
  return (
    /\.(test|spec)\.(ts|tsx|mts)$/.test(relativePath) ||
    /(^|\/)(test|tests|__tests__)\//.test(relativePath)
  );
}

/** Resolves a capability's declared symbol in the program. */
function resolveSymbol(checker, program, rootDir, capabilitySymbol) {
  const source = program.getSourceFile(path.join(rootDir, capabilitySymbol.file));
  if (!source) {
    throw new Error(`Capability file is not in the program: ${capabilitySymbol.file}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.name === capabilitySymbol.name)
    : undefined;
  if (!exported) {
    throw new Error(`${capabilitySymbol.file} does not export ${capabilitySymbol.name}`);
  }
  const target =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (!capabilitySymbol.member) {
    return target;
  }
  const member = target.members?.get(capabilitySymbol.member);
  if (!member) {
    throw new Error(`${capabilitySymbol.name} has no member ${capabilitySymbol.member}`);
  }
  return member;
}

/**
 * Finds every capability reference outside its allowlist, and every stale
 * allowlist entry. Returns human-readable violations.
 *
 * @param {{ rootDir: string, tsconfig: string, capabilities?: Capability[] }} options
 */
export function findValueMovementViolations({ rootDir, tsconfig, capabilities = CAPABILITIES }) {
  const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfig));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();

  const targets = new Map();
  for (const capability of capabilities) {
    for (const capabilitySymbol of capability.symbols) {
      targets.set(resolveSymbol(checker, program, rootDir, capabilitySymbol), capability);
    }
  }

  const violations = [];
  const used = new Map(capabilities.map((capability) => [capability.id, new Set()]));
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const relativePath = path.relative(rootDir, source.fileName).split(path.sep).join("/");
    if (relativePath.startsWith("..") || relativePath.includes("node_modules/")) continue;
    if (isTestFile(relativePath)) continue;

    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        const capability = symbol ? targets.get(symbol) : undefined;
        if (capability && !capability.owners.includes(relativePath)) {
          if (capability.allow.includes(relativePath)) {
            used.get(capability.id).add(relativePath);
          } else {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(
              `${relativePath}:${line + 1}: references ${capability.id} (${node.text}). ${capability.why}`
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const capability of capabilities) {
    for (const allowed of capability.allow) {
      if (!used.get(capability.id).has(allowed)) {
        violations.push(
          capability.shrinkOnly
            ? `${allowed}: no longer references ${capability.id}; remove it from the allowlist (the list only shrinks).`
            : `${allowed}: allowlisted for ${capability.id} but does not reference it.`
        );
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsconfig = path.join(rootDir, "apps/sdp-api/tsconfig.json");
  if (!existsSync(tsconfig)) {
    console.error(`Missing ${tsconfig}`);
    process.exit(1);
  }
  const violations = findValueMovementViolations({ rootDir, tsconfig });
  if (violations.length > 0) {
    console.error("Value movement check failed (HOO-1955):");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("Value movement check passed.");
}
