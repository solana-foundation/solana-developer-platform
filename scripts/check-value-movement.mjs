/**
 * Pins where API code may turn a stored secret into signing authority
 * (HOO-1955; see the money admission ADR in docs/decisions).
 *
 * Money admission is enforced inside the two narrow waists every signature
 * passes: the custody signer (`CustodyRuntimeTargets#getTransactionSignerForWalletRecord`)
 * and the fee sponsor (`createSponsorshipFeePayment`). Wrappers above them are
 * harmless, because they still reach the waist. What would bypass admission is
 * code below them: building a signing adapter from an encrypted config or a
 * provider credential, a provider keychain adapter, a fee-payment adapter, or
 * a keypair from raw bytes, and signing with it directly. This check pins
 * those constructors to the files that use them today.
 *
 * It resolves every identifier with the TypeScript checker, so a reference
 * counts however it is spelled: `@/` alias or relative import, renamed import,
 * re-export, namespace access, or a value passed along. Any reference from a
 * file outside a capability's allowlist fails, and an allowlisted file that no
 * longer references it fails too, so the lists can only shrink. Inside an
 * allowlisted file a constructor may only be called, constructed or
 * re-exported by name; handing it out as a value under a new symbol (an alias
 * constant, an object entry, a subclass, an argument) fails. Tests may
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
const KEYCHAIN = "packages/sdp-custody/src/keychain";

/** Providers with a `Keychain<Provider>Adapter` in `@sdp/custody/keychain`. */
const KEYCHAIN_PROVIDERS = [
  "coinbase",
  "dfns",
  "fireblocks",
  "ibm-haven",
  "memory",
  "para",
  "privy",
  "turnkey",
  "utila",
];

/** `ibm-haven` → `IbmHaven`. */
function pascalCase(slug) {
  return slug
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

/** @typedef {{ file?: string, module?: string, name: string, member?: string }} CapabilitySymbol */
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
  {
    id: "keychain-signing-adapter",
    why: "Holds a provider secret and can sign; only the adapter factory and the wallet lifecycle may build one.",
    symbols: [
      ...KEYCHAIN_PROVIDERS.map((provider) => ({
        file: `${KEYCHAIN}/keychain-${provider}.adapter.ts`,
        name: `Keychain${pascalCase(provider)}Adapter`,
      })),
    ],
    owners: [],
    allow: [
      `${API}/services/adapters/index.ts`,
      `${API}/services/adapters/signing/index.ts`,
      `${API}/services/domain/signing.service.ts`,
      `${API}/services/domain/signing/provider-adapter-factory.ts`,
      `${API}/services/domain/signing/provider-wallet-lifecycle.ts`,
    ],
    shrinkOnly: true,
  },
  {
    id: "native-fee-payer",
    why: "Signs as fee payer with a process key and no budget; the sponsorship waist builds fee payers.",
    symbols: [
      { file: `${FEE_PAYMENT}/native.adapter.ts`, name: "NativeAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "createNativeAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "KoraClient" },
    ],
    owners: [],
    allow: [],
  },
  {
    id: "keypair-signer",
    why: "Turns raw private-key bytes into a signer; only local key creation in the signing service may.",
    symbols: [{ module: "@solana/signers", name: "createKeyPairSignerFromPrivateKeyBytes" }],
    owners: [],
    allow: [`${API}/services/domain/signing.service.ts`],
    shrinkOnly: true,
  },
];

/** Test files and the API's own test-support tree; nothing else is exempt. */
function isTestFile(relativePath) {
  return (
    /\.(test|spec)\.(ts|tsx|mts)$/.test(relativePath) ||
    relativePath.startsWith(`${API}/test/`) ||
    relativePath.startsWith("src/test/")
  );
}

/** Wrappers that leave an expression's value unchanged. */
function unwrapParent(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether a reference inside an owner or allowlisted file only uses the
 * capability: calls or constructs it, calls one of its static or instance
 * methods, names it in an import or re-export (the checker follows those
 * aliases), declares it, or names it as a type. Anything else (assigning it,
 * passing or returning it, putting it in an object, subclassing it) hands the
 * constructor out under a symbol the check no longer pins.
 */
function isPinnedUse(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  ) {
    return true;
  }
  if (
    (ts.isClassDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  for (let ancestor = parent; ancestor && !ts.isStatement(ancestor); ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor) && !ts.isExpressionWithTypeArguments(ancestor)) return true;
  }
  // `x.sign()` / `X.fromBase58()`: the member access is what gets called.
  let callee = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    callee = parent;
  } else if (ts.isElementAccessExpression(node)) {
    callee = node;
  }
  callee = unwrapParent(callee);
  if (
    callee.parent &&
    (ts.isPropertyAccessExpression(callee.parent) || ts.isElementAccessExpression(callee.parent)) &&
    callee.parent.expression === callee
  ) {
    callee = unwrapParent(callee.parent);
  }
  return Boolean(
    callee.parent &&
      (ts.isCallExpression(callee.parent) || ts.isNewExpression(callee.parent)) &&
      callee.parent.expression === callee
  );
}

/** Resolves a package specifier (an external constructor) the way the program does. */
function resolveModuleSource(program, specifier) {
  const containingFile = program.getRootFileNames()[0];
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    program.getCompilerOptions(),
    ts.sys
  ).resolvedModule;
  return resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
}

/** Resolves a capability's declared symbol in the program. */
function resolveSymbol(checker, program, rootDir, capabilitySymbol) {
  const source = capabilitySymbol.module
    ? resolveModuleSource(program, capabilitySymbol.module)
    : program.getSourceFile(path.join(rootDir, capabilitySymbol.file));
  if (!source) {
    throw new Error(
      `Capability source is not in the program: ${capabilitySymbol.module ?? capabilitySymbol.file}`
    );
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

    const report = (node, symbol, label, { module = false } = {}) => {
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const capability = symbol ? targets.get(symbol) : undefined;
      if (!capability) return;
      const owner = capability.owners.includes(relativePath);
      const allowed = capability.allow.includes(relativePath);
      if (allowed) used.get(capability.id).add(relativePath);
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (!owner && !allowed) {
        violations.push(
          `${relativePath}:${line + 1}: references ${capability.id} (${label}). ${capability.why}`
        );
      } else if (!module && !isPinnedUse(node)) {
        violations.push(
          `${relativePath}:${line + 1}: hands ${capability.id} out as a value (${label}); an allowlisted file may only call it, construct it or re-export it by name, so every reference elsewhere still resolves to it. ${capability.why}`
        );
      }
    };
    // A whole module handed out as a value (namespace import, require, dynamic
    // import, export *) carries every pinned constructor it exports, including
    // ones it only re-exports from elsewhere.
    const reportModule = (node, specifier) => {
      const moduleSymbol = checker.getSymbolAtLocation(specifier);
      if (!moduleSymbol) return;
      const reported = new Set();
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol =
          exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const capability = targets.get(symbol);
        if (capability && !reported.has(capability.id)) {
          reported.add(capability.id);
          report(node, symbol, `module ${specifier.text}`, { module: true });
        }
      }
    };
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        report(node, checker.getSymbolAtLocation(node), node.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const property = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.expression),
          node.argumentExpression.text
        );
        report(node, property, node.argumentExpression.text);
      } else if (
        ts.isBindingElement(node) &&
        !node.propertyName &&
        ts.isIdentifier(node.name) &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        const property = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.parent),
          node.name.text
        );
        report(node, property, node.name.text);
      } else if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings &&
        ts.isNamespaceImport(node.importClause.namedBindings) &&
        !node.importClause.isTypeOnly
      ) {
        reportModule(node, node.moduleSpecifier);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        !node.isTypeOnly &&
        (!node.exportClause || ts.isNamespaceExport(node.exportClause))
      ) {
        reportModule(node, node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        reportModule(node, node.arguments[0]);
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
