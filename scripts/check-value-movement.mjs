/**
 * Pins where API code may turn a stored secret into signing authority
 * (HOO-1955; see the money admission ADR in docs/decisions).
 *
 * Money admission is enforced inside the two narrow waists every signature
 * passes: the custody signer (`CustodyRuntimeTargets#getTransactionSignerForWalletRecord`)
 * and the fee sponsor (`createSponsorshipFeePayment`). Wrappers above them are
 * harmless, because they still reach the waist. What would bypass admission is
 * code below them: building a signing adapter from an encrypted config or a
 * provider credential, or a fee-payment adapter, and signing with it directly.
 * This check pins those constructors to the waist files.
 *
 * It resolves every identifier with the TypeScript checker, so a reference
 * counts however it is spelled: `@/` alias or relative import, renamed import,
 * re-export, namespace access, or a value passed along. Any reference from a
 * file outside a capability's allowlist fails, and an allowlisted file that no
 * longer references it fails too, so the lists can only shrink. Tests may
 * reference anything: they exercise these constructors.
 *
 * Adding a file to any list below is a security-reviewed change.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const API = "apps/sdp-api/src";
const FEE_PAYMENT = "packages/sdp-payments/src/fee-payment";

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
    id: "config-signing-adapter",
    why: "Builds a signing adapter from an encrypted custody config; only the custody signer waist may.",
    symbols: [
      {
        file: `${API}/services/domain/signing/provider-adapter-factory.ts`,
        // biome-ignore lint/security/noSecrets: a function name, not a secret.
        name: "createAdapterFromEncryptedConfig",
      },
    ],
    owners: [`${API}/services/domain/signing/provider-adapter-factory.ts`],
    allow: [`${API}/services/domain/signing.service.ts`],
    shrinkOnly: true,
  },
  {
    id: "credential-signing-adapter",
    why: "Builds a signing adapter from a BYOK provider credential; only the custody signer waist may.",
    symbols: [
      {
        file: `${API}/services/domain/signing/provider-adapter-factory.ts`,
        name: "createPrivyAdapterFromCredential",
      },
    ],
    owners: [`${API}/services/domain/signing/provider-adapter-factory.ts`],
    allow: [`${API}/services/domain/signing/custody-runtime-target.ts`],
    shrinkOnly: true,
  },
  {
    id: "fee-payment-adapter",
    why: "Builds a fee payer that can sponsor-sign; only the sponsorship waist may.",
    symbols: [
      { file: `${FEE_PAYMENT}/index.ts`, name: "createFeePaymentAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "createKoraAdapter" },
      { file: `${FEE_PAYMENT}/kora.adapter.ts`, name: "KoraAdapter" },
    ],
    owners: [],
    allow: [`${API}/services/sponsorship.service.ts`],
    shrinkOnly: true,
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
 * @param {{ rootDir: string, tsconfig: string, capabilities?: Capability[], scanRoot?: string }} options
 */
export function findValueMovementViolations({
  rootDir,
  tsconfig,
  capabilities = CAPABILITIES,
  scanRoot = "",
}) {
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
    if (!relativePath.startsWith(scanRoot)) continue;
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
  const violations = findValueMovementViolations({ rootDir, tsconfig, scanRoot: `${API}/` });
  if (violations.length > 0) {
    console.error("Value movement check failed (HOO-1955):");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("Value movement check passed.");
}
