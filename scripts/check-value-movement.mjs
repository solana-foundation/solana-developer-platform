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
 * those constructors to the files that use them today. A provider signer
 * module or keychain SDK is pinned whole (every callable it exports), so a
 * signer added to it later is covered without a new entry here.
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
 * It scans the API and every package the API loads. The packages that define
 * these constructors own them and use them freely; any other package is held
 * to the same lists as API code. What it cannot see is a file it already
 * allows wrapping a pinned constructor in a new function: those files are
 * trusted, so a change inside one is reviewed like the waists themselves.
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
/**
 * The packages that define these constructors. They build, subclass and pass
 * their own adapters around freely; every other package is checked like API
 * code. A trailing slash makes an owner a directory.
 */
const CUSTODY_PACKAGE = "packages/sdp-custody/src/";
const FEE_PAYMENT_PACKAGE = `${FEE_PAYMENT}/`;

/** Provider keychain SDKs: each export can hold a provider secret and sign. */
const KEYCHAIN_SDKS = [
  "@solana/keychain-cdp",
  "@solana/keychain-fireblocks",
  "@solana/keychain-para",
  "@solana/keychain-privy",
  "@solana/keychain-turnkey",
  "@solana/keychain-utila",
];

/** @typedef {{ file?: string, module?: string, name: string }} CapabilitySymbol */
/**
 * @typedef {{
 *   id: string,
 *   why: string,
 *   symbols: CapabilitySymbol[],
 *   owners: string[],
 *   allow: string[],
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
  },
  {
    id: "fee-payment-adapter",
    why: "Builds a fee payer that can sponsor-sign; only the sponsorship waist may.",
    symbols: [
      { file: `${FEE_PAYMENT}/index.ts`, name: "createFeePaymentAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "createKoraAdapter" },
      { file: `${FEE_PAYMENT}/kora.adapter.ts`, name: "KoraAdapter" },
    ],
    owners: [FEE_PAYMENT_PACKAGE],
    allow: [`${API}/services/sponsorship.service.ts`],
  },
  {
    id: "keychain-signing-adapter",
    why: "Holds a provider secret and can sign; only the adapter factory and the wallet lifecycle may build one.",
    symbols: [{ file: `${KEYCHAIN}/index.ts`, name: "*" }],
    owners: [CUSTODY_PACKAGE],
    allow: [
      `${API}/services/adapters/index.ts`,
      `${API}/services/adapters/signing/index.ts`,
      `${API}/services/domain/signing.service.ts`,
      `${API}/services/domain/signing/provider-adapter-factory.ts`,
      `${API}/services/domain/signing/provider-wallet-lifecycle.ts`,
    ],
  },
  {
    id: "provider-signer",
    why: "A provider signer or API client builds signing authority from a stored credential; only the signing service, the adapter factory and the wallet lifecycle may use one.",
    symbols: [
      { file: "packages/sdp-custody/src/dfns/index.ts", name: "*" },
      ...KEYCHAIN_SDKS.map((module) => ({ module, name: "*" })),
    ],
    owners: [CUSTODY_PACKAGE],
    allow: [
      `${API}/services/domain/signing.service.ts`,
      `${API}/services/domain/signing/provider-adapter-factory.ts`,
      `${API}/services/domain/signing/provider-wallet-lifecycle.ts`,
    ],
  },
  {
    id: "native-fee-payer",
    why: "Signs as fee payer with a process key and no budget; the sponsorship waist builds fee payers.",
    symbols: [
      { file: `${FEE_PAYMENT}/native.adapter.ts`, name: "NativeAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "createNativeAdapter" },
      { file: `${FEE_PAYMENT}/index.ts`, name: "KoraClient" },
    ],
    owners: [FEE_PAYMENT_PACKAGE],
    allow: [],
  },
  {
    id: "keypair-signer",
    why: "Turns raw private-key bytes into a signer or key pair; only local key creation in the signing service may.",
    // Every constructor Kit offers from stored bytes, resolved through
    // `@solana/kit` so its re-exports of `@solana/signers` and `@solana/keys`
    // count however they are imported.
    symbols: [
      { module: "@solana/kit", name: "createKeyPairSignerFromPrivateKeyBytes" },
      { module: "@solana/kit", name: "createKeyPairSignerFromBytes" },
      { module: "@solana/kit", name: "createKeyPairFromPrivateKeyBytes" },
      { module: "@solana/kit", name: "createKeyPairFromBytes" },
    ],
    owners: [],
    allow: [
      `${API}/services/domain/signing.service.ts`,
      // Each builds the keypair inside a constructor that is pinned itself.
      `${KEYCHAIN}/keychain-memory.adapter.ts`,
      `${FEE_PAYMENT}/native.adapter.ts`,
    ],
  },
];

/** Test files and the API's own test-support tree; nothing else is exempt. */
function isTestFile(relativePath) {
  return (
    /\.(test|spec)\.(ts|tsx|mts)$/.test(relativePath) || relativePath.startsWith(`${API}/test/`)
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
 * capability: calls or constructs it, calls one of its instance methods or a
 * static method it declares, names it in an import or re-export (the checker follows those
 * aliases), declares it, or names it as a type. Anything else (assigning it,
 * passing or returning it, putting it in an object, subclassing it) hands the
 * constructor out under a symbol the check no longer pins.
 */
function isPinnedUse(checker, node) {
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
  if (inTypePosition(node)) return true;
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
    // Only a static method the capability itself declares: `bind`, `call` and
    // `apply` come from `Function` and hand the constructor back out.
    const member = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(callee.parent)
        ? callee.parent.name
        : callee.parent.argumentExpression
    );
    if (!member?.declarations?.some((declaration) => ts.isClassLike(declaration.parent))) {
      return false;
    }
    callee = unwrapParent(callee.parent);
  }
  return Boolean(
    callee.parent &&
      (ts.isCallExpression(callee.parent) || ts.isNewExpression(callee.parent)) &&
      callee.parent.expression === callee
  );
}

/**
 * Whether a reference only names a type, which can never run: a type node, or
 * a type-only import or export (TypeScript erases both).
 */
function inTypePosition(node) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (
      (ts.isImportSpecifier(ancestor) ||
        ts.isImportClause(ancestor) ||
        ts.isExportSpecifier(ancestor) ||
        ts.isExportDeclaration(ancestor)) &&
      ancestor.isTypeOnly
    ) {
      return true;
    }
    if (ts.isStatement(ancestor)) return false;
    if (ts.isTypeNode(ancestor) && !ts.isExpressionWithTypeArguments(ancestor)) return true;
  }
  return false;
}

/** The runtime's ways to load or build code from a value. */
const CODE_LOADERS = new Set(["createRequire", "eval", "Function", "require"]);

/**
 * Code the checker cannot resolve: an `import()` whose specifier is not a
 * literal, or any reference, however it is renamed or reached, to the
 * runtime's `createRequire`, `eval`, `Function` or `require` (other than
 * `require` called with a literal, which the module checks follow). None of
 * it is needed in API code, so it is refused outright.
 */
function isOpaqueCodeLoad(checker, node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
  ) {
    return true;
  }
  let symbol;
  if (ts.isIdentifier(node)) {
    symbol = checker.getSymbolAtLocation(node);
  } else if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    symbol = checker.getPropertyOfType(
      checker.getTypeAtLocation(node.expression),
      node.argumentExpression.text
    );
  }
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol || !CODE_LOADERS.has(symbol.getName())) return false;
  // A member of the same name (a Redis client's `eval`) is not the runtime's.
  if (symbol.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Property)) return false;
  // Declared by the runtime (lib or @types/node), not a local of the same name.
  if (!symbol.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile)) {
    return false;
  }
  if (inTypePosition(node)) return false;
  const call = node.parent;
  return !(
    symbol.getName() === "require" &&
    ts.isCallExpression(call) &&
    call.expression === node &&
    call.arguments[0] &&
    ts.isStringLiteralLike(call.arguments[0])
  );
}

/**
 * For a whole-module reference in an allowlisted file: whether it hands the
 * module out as one value. A plain `export *` re-exports each constructor
 * under its own name, which every caller still resolves to, and a namespace
 * import is recorded so its later uses are checked. A named namespace export,
 * a dynamic import or a require hands the whole module out.
 */
function handsModuleOut(checker, node, pinnedNamespaces) {
  if (ts.isImportDeclaration(node)) {
    pinnedNamespaces.add(checker.getSymbolAtLocation(node.importClause.namedBindings.name));
    return false;
  }
  return !(ts.isExportDeclaration(node) && !node.exportClause);
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

/** Resolves a capability's declared symbols in the program (`name: "*"` is every value export). */
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
  const resolve = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (capabilitySymbol.name === "*") {
    // Every callable or constructible value the module exports: a provider
    // SDK or signer module is pinned whole, so a constructor added to it later
    // is pinned too. Plain constants cannot sign and stay free.
    const values = (moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [])
      .map(resolve)
      .filter((symbol) => {
        if (!(symbol.flags & ts.SymbolFlags.Value)) return false;
        const type = checker.getTypeOfSymbol(symbol);
        return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
      });
    if (values.length === 0) {
      throw new Error(`${capabilitySymbol.module ?? capabilitySymbol.file} exports no values`);
    }
    return values;
  }
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.name === capabilitySymbol.name)
    : undefined;
  if (!exported) {
    throw new Error(`${capabilitySymbol.file} does not export ${capabilitySymbol.name}`);
  }
  return [resolve(exported)];
}

/**
 * Finds every capability reference outside its allowlist, and every stale
 * allowlist entry. Returns human-readable violations.
 *
 * @param {{ rootDir: string, tsconfig: string, capabilities: Capability[], scanRoots: string[] }} options
 */
export function findValueMovementViolations({ rootDir, tsconfig, capabilities, scanRoots }) {
  for (const [name, value] of Object.entries({ rootDir, tsconfig, capabilities, scanRoots })) {
    if (value === undefined) throw new Error(`findValueMovementViolations needs ${name}`);
  }
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
      for (const symbol of resolveSymbol(checker, program, rootDir, capabilitySymbol)) {
        targets.set(symbol, capability);
      }
    }
  }

  const violations = [];
  const used = new Map(capabilities.map((capability) => [capability.id, new Set()]));
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const relativePath = path.relative(rootDir, source.fileName).split(path.sep).join("/");
    if (relativePath.startsWith("..") || relativePath.includes("node_modules/")) continue;
    if (!scanRoots.some((scanRoot) => relativePath.startsWith(scanRoot))) continue;
    if (isTestFile(relativePath)) continue;

    // Namespace imports in this file that carry a pinned constructor. An
    // allowlisted file may call through one (`ns.Adapter(...)`), but not hand
    // the namespace itself on or index it with a computed name.
    const pinnedNamespaces = new Set();
    const report = (node, symbol, label, viaModule) => {
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const capability = symbol ? targets.get(symbol) : undefined;
      if (!capability) return;
      // A defining package may use its own constructors however it likes.
      if (
        capability.owners.some((owner) => owner.endsWith("/") && relativePath.startsWith(owner))
      ) {
        return;
      }
      const owner = capability.owners.includes(relativePath);
      const allowed = capability.allow.includes(relativePath);
      if (allowed) used.get(capability.id).add(relativePath);
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (!owner && !allowed) {
        violations.push(
          `${relativePath}:${line + 1}: references ${capability.id} (${label}). ${capability.why}`
        );
      } else if (viaModule) {
        if (handsModuleOut(checker, node, pinnedNamespaces)) {
          violations.push(
            `${relativePath}:${line + 1}: hands ${capability.id} out as a module value (${label}); an allowlisted file may only re-export it with a plain \`export *\`. ${capability.why}`
          );
        }
      } else if (!isPinnedUse(checker, node)) {
        violations.push(
          `${relativePath}:${line + 1}: hands ${capability.id} out as a value (${label}); an allowlisted file may only call it, construct it or re-export it by name, so every reference elsewhere still resolves to it. ${capability.why}`
        );
      }
    };
    /** A namespace of pinned constructors used as anything but `ns.member`. */
    const reportNamespaceHandOut = (node) => {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || !pinnedNamespaces.has(symbol)) return;
      const parent = node.parent;
      if (ts.isNamespaceImport(parent) && parent.name === node) return;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
      // `ns["mint"]` names its member, which the element-access check resolves.
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        return;
      }
      if (inTypePosition(node)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(
        `${relativePath}:${line + 1}: hands a namespace of pinned constructors out (${node.text}); call through it by name instead.`
      );
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
          report(node, symbol, `module ${specifier.text}`, true);
        }
      }
    };
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        reportNamespaceHandOut(node);
        report(node, checker.getSymbolAtLocation(node), node.text, false);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const property = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.expression),
          node.argumentExpression.text
        );
        report(node, property, node.argumentExpression.text, false);
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
        report(node, property, node.name.text, false);
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
      if (isOpaqueCodeLoad(checker, node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${relativePath}:${line + 1}: loads code the check cannot follow (a computed import, require, createRequire, eval or Function); name the module literally.`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const capability of capabilities) {
    for (const allowed of capability.allow) {
      if (!used.get(capability.id).has(allowed)) {
        violations.push(
          `${allowed}: no longer references ${capability.id}; remove it from the allowlist (the list only shrinks).`
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
  const violations = findValueMovementViolations({
    rootDir,
    tsconfig,
    capabilities: CAPABILITIES,
    // The API and every package it loads: a package other than the defining
    // ones gets no more room than API code.
    scanRoots: [`${API}/`, "packages/"],
  });
  if (violations.length > 0) {
    console.error("Value movement check failed (HOO-1955):");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("Value movement check passed.");
}
