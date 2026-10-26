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
 * It also pins who may set the money principal (HOO-2099): the ambient
 * identity the waists check a signature against. Only the entry points that
 * authenticated it set it, so no handler can name a more privileged one.
 *
 * It also bans casts to the token-movement amount types (ADR 0012, token
 * movements): `BaseUnits`, `TokenAmount`, `MovementQuote`, `MovementIntent`
 * and `AssetRef`. Their constructors check the u64 range, the
 * mint's scale and `debit = credit + fee`; an `as` or `<T>` assertion skips
 * them, and so does an `as never` or `as any` that lands in one. Only each
 * type's defining module may assert it, and tests are free.
 * This part scans the API, the dashboard and every package.
 *
 * Adding a file to any list below is a security-reviewed change.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const API = "apps/sdp-api/src";
const FEE_PAYMENT = "packages/sdp-fee-payment/src";
/** The repo root, from this file's location, so the check runs from any directory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    id: "fireblocks-native-transfer",
    why: "Creates a provider-signed payment; only the admitted Fireblocks submission service may.",
    symbols: [
      {
        file: "packages/sdp-custody/src/provisioning/fireblocks-transfers.ts",
        name: "createFireblocksTransfer",
      },
    ],
    owners: [CUSTODY_PACKAGE],
    allow: [`${API}/services/payments/fireblocks-transfer.ts`],
  },
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
      {
        file: `${API}/services/domain/signing/provider-adapter-factory.ts`,
        name: "createFireblocksAdapterFromCredential",
      },
    ],
    owners: [`${API}/services/domain/signing/provider-adapter-factory.ts`],
    allow: [`${API}/services/domain/signing/custody-runtime-target.ts`],
  },
  {
    id: "fee-payment-adapter",
    why: "Builds a fee payer that can sponsor-sign; only the sponsorship waist may.",
    symbols: [
      { file: `${FEE_PAYMENT}/index.ts`, name: "createKoraAdapter" },
      { file: `${FEE_PAYMENT}/kora.adapter.ts`, name: "KoraAdapter" },
    ],
    owners: [FEE_PAYMENT_PACKAGE],
    allow: [`${API}/services/sponsorship.service.ts`],
  },
  {
    id: "keychain-signing-adapter",
    why: "Holds a provider secret and can sign; only the adapter factory and the wallet lifecycle may build one.",
    symbols: readdirSync(path.join(REPO_ROOT, KEYCHAIN))
      .filter((file) => file.endsWith(".adapter.ts") && !file.endsWith(".test.ts"))
      .sort()
      .map((file) => ({ file: `${KEYCHAIN}/${file}`, name: "*" })),
    owners: [CUSTODY_PACKAGE],
    allow: [
      `${API}/services/domain/signing.service.ts`,
      `${API}/services/domain/signing/provider-adapter-factory.ts`,
      `${API}/services/domain/signing/provider-wallet-lifecycle.ts`,
    ],
  },
  {
    id: "provider-signer",
    why: "A provider signer or API client builds signing authority from a stored credential; only the signing service, the adapter factory and the wallet lifecycle may use one.",
    symbols: [
      ...readdirSync(path.join(REPO_ROOT, "packages/sdp-custody/src/dfns"))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .sort()
        .map((file) => ({ file: `packages/sdp-custody/src/dfns/${file}`, name: "*" })),
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
    id: "kora-client",
    why: "Asks Kora to sign as fee payer with no budget; the sponsorship waist builds fee payers.",
    symbols: [{ module: "@solana/kora", name: "KoraClient" }],
    owners: [FEE_PAYMENT_PACKAGE],
    allow: [],
  },
  {
    id: "money-principal",
    why: "Sets who a request or job moves money for, which the signing waists admit; only the authenticating entry points may (HOO-2099).",
    symbols: [{ file: `${API}/lib/money-principal.ts`, name: "runAsMoneyPrincipal" }],
    owners: [`${API}/lib/money-principal.ts`],
    allow: [
      // An API key, as authenticated from its live row.
      `${API}/middleware/auth.ts`,
      // A signed-in member, as authenticated from their session.
      `${API}/middleware/clerk-auth.ts`,
      // The recurring-payment job, as the mandate it collects (APE-343).
      `${API}/services/jobs/collect-recurring-payments.ts`,
      // A `/pay` link, as the payment request its token names.
      `${API}/routes/pay/context.ts`,
    ],
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
    ],
  },
];

const SOLANA = "packages/sdp-solana/src";

/**
 * @typedef {{ file: string, name: string }} BrandedType
 */

/**
 * The token-movement types no code outside `file` may assert (ADR 0012).
 *
 * @type {BrandedType[]}
 */
export const BRANDED_TYPES = [
  { file: `${SOLANA}/token-amount.ts`, name: "BaseUnits" },
  { file: `${SOLANA}/token-amount.ts`, name: "TokenAmount" },
  { file: `${SOLANA}/movement-quote.ts`, name: "MovementQuote" },
  { file: `${SOLANA}/movement-quote.ts`, name: "MovementIntent" },
  { file: `${SOLANA}/asset-ref.ts`, name: "AssetRef" },
];

// biome-ignore-start lint/security/noSecrets: SDK and function names, not secrets.
/**
 * @typedef {{
 *   id: string,
 *   why: string,
 *   imports: { packages: string[], names: string[] }[],
 *   allow: string[],
 * }} BuilderRule
 */

/**
 * Who may build a token movement (ADR 0012, decisions 7 and 8): a source file
 * that imports one of a rule's builders from its package must be on the rule's
 * list, and every listed file must still import one, so the lists only
 * shrink. A text check: it sees named, renamed and namespace imports, not a
 * builder handed on through another module, so a listed file is reviewed like
 * the waists. Tests are free.
 *
 * @type {BuilderRule[]}
 */
export const TOKEN_MOVEMENT_BUILDERS = [
  {
    id: "token-movement-transfer",
    why: "builds a token transfer; only the token movement builder and the registered adapters may",
    imports: [
      {
        packages: ["@solana-program/token", "@solana-program/token-2022"],
        names: [
          "getTransferCheckedInstruction",
          "getTransferCheckedWithFeeInstruction",
          "getTransferCheckedWithTransferHookInstructionAsync",
          "getTransferToATAInstructionPlan",
          "getTransferToATAInstructionPlanAsync",
        ],
      },
      // A Solana Pay transfer from a decimal amount it converts itself; /pay builds with the builder.
      { packages: ["@solana/pay"], names: ["createTransfer"] },
    ],
    allow: [
      // The builder: `TransferCheckedWithFee` when the mint has a fee config, else `TransferChecked`.
      `${SOLANA}/token-movement.ts`,
      // SPC's Token-2022 `TransferChecked`; the `private_channels` row refuses fee and hook mints.
      `${API}/services/private-channels/transfer.ts`,
      // Moves the owner's classic kvault share tokens into its ATA.
      "packages/sdp-kamino/src/withdraw-instructions.ts",
      // WisdomTree's legs: its resolver adds the fund's hook accounts, and Earn's row decides the mint.
      "packages/sdp-wisdomtree/src/plan.ts",
    ],
  },
  {
    id: "token-movement-unchecked-transfer",
    why: "builds the unchecked `Transfer`, which names no mint or decimals, so a fee settles short",
    imports: [
      {
        packages: ["@solana-program/token", "@solana-program/token-2022"],
        names: ["getTransferInstruction"],
      },
    ],
    allow: [
      // SPC checks instruction bytes against its program allowlist, so a classic mint keeps `Transfer`.
      `${API}/services/private-channels/transfer.ts`,
    ],
  },
  {
    id: "token-movement-mosaic",
    why: "Mosaic mints, burns or moves tokens from a JS number it converts itself; only the issuance adapter may",
    imports: [
      {
        packages: ["@solana/mosaic-sdk"],
        names: [
          "createMintToTransaction",
          "createBurnTransaction",
          "createPermissionedBurnTransaction",
          "createForceBurnTransaction",
          "createForceTransferTransaction",
          "createTransferInstructions",
          "createTransferTransaction",
          "createMintLockTransaction",
          "createBurnLockTransaction",
          "createSettleMintLockTransaction",
          "createCancelMintLockTransaction",
          "createSettleBurnLockTransaction",
          "createCancelBurnLockTransaction",
          "decimalAmountToRaw",
        ],
      },
    ],
    allow: [
      // Mint, seize and force burn, each amount from `mosaicAmountUnderLiveTerms`.
      "packages/sdp-issuance/src/mosaic/service.ts",
      // Burn, its amount from `mosaicAmountUnderLiveTerms`.
      `${SOLANA}/token-2022.ts`,
      // Checks that Mosaic's conversion gives back exactly the amount's base units.
      `${SOLANA}/mosaic-amount.ts`,
    ],
  },
  {
    id: "token-movement-recurring",
    why: "builds a subscriptions-program pull or writes the amount it pulls later; only the recurring adapter may",
    imports: [
      {
        packages: ["@solana/subscriptions"],
        names: [
          "getTransferSubscriptionInstruction",
          "getTransferSubscriptionInstructionAsync",
          "getTransferSubscriptionOverlayInstructionAsync",
          "getTransferFixedInstruction",
          "getTransferFixedInstructionAsync",
          "getTransferFixedOverlayInstructionAsync",
          "getTransferRecurringInstruction",
          "getTransferRecurringInstructionAsync",
          "getTransferRecurringOverlayInstructionAsync",
          "getCreatePlanInstruction",
          "getCreatePlanOverlayInstructionAsync",
          "getSubscribeInstruction",
          "getSubscribeInstructionAsync",
          "getSubscribeOverlayInstructionAsync",
          "getCreateFixedDelegationInstruction",
          "getCreateFixedDelegationOverlayInstructionAsync",
          "getCreateRecurringDelegationInstruction",
          "getCreateRecurringDelegationOverlayInstructionAsync",
        ],
      },
    ],
    allow: [
      `${API}/services/payments/recurring-payments/collection.ts`,
      `${API}/services/payments/recurring-payments/activation.ts`,
      `${API}/services/payments/recurring-payments/update.ts`,
      `${API}/routes/payments/subscription-plans/handlers.ts`,
      `${API}/routes/payments/subscriptions/handlers.ts`,
    ],
  },
];
// biome-ignore-end lint/security/noSecrets: SDK and function names, not secrets.

/**
 * The `names` a file takes from `pkg`: a value import or re-export of one
 * (renamed or not), or a read of a namespace or default import of the package
 * (see {@link namespaceReads}). `export *`, a dynamic `import()` and a
 * `require()` of it take every name: the check cannot follow them.
 *
 * @param {ts.SourceFile} source
 * @param {string} pkg
 * @param {string[]} names
 */
function importedNames(source, pkg, names) {
  const taken = new Set();
  const namespaces = new Set();
  const take = (taking) => {
    for (const name of taking) taken.add(name);
  };
  for (const statement of source.statements) {
    if (!fromPackage(statement, pkg)) continue;
    if (ts.isExportDeclaration(statement)) {
      take(reexportedNames(statement, names));
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings) {
      take(
        bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text)
      );
    }
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && namespaces.has(node.text)) take(namespaceReads(node, names));
    if (loadsPackage(node, pkg)) take(names);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names.filter((name) => taken.has(name));
}

/** Whether a statement is a value import or re-export from `pkg`. */
function fromPackage(statement, pkg) {
  return (
    (ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && !statement.isTypeOnly)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === pkg
  );
}

/** The names a re-export from the package passes on: all of them for `export *`. */
function reexportedNames(statement, names) {
  const exported = statement.exportClause;
  if (!exported || ts.isNamespaceExport(exported)) return names;
  return exported.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
}

/** Whether a node is a dynamic `import()` or a `require()` of `pkg`. */
function loadsPackage(node, pkg) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const [specifier] = node.arguments;
  return (
    (callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require")) &&
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    specifier.text === pkg
  );
}

/**
 * The members one mention of a namespace's identifier reads: what a dot, a
 * string key or a destructuring names; none for a declaration, a same-named
 * property or a type; every name for any other use (a computed key, a rest
 * pattern, the namespace passed on), which the check cannot follow.
 *
 * @param {ts.Identifier} node
 * @param {string[]} names
 */
function namespaceReads(node, names) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) {
    return parent.expression === node ? [parent.name.text] : [];
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    return ts.isStringLiteralLike(parent.argumentExpression)
      ? [parent.argumentExpression.text]
      : names;
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    const pattern = parent.name;
    if (!ts.isObjectBindingPattern(pattern)) return names;
    const keys = pattern.elements.map((element) => element.propertyName ?? element.name);
    return pattern.elements.some((element) => element.dotDotDotToken) ||
      keys.some((key) => !ts.isIdentifier(key) && !ts.isStringLiteralLike(key))
      ? names
      : keys.map((key) => key.text);
  }
  if (ts.isShorthandPropertyAssignment(parent)) return names;
  if (ts.isExportSpecifier(parent)) {
    // `export { token }` and `export { token as t }` hand the namespace out; in `export { x as token }`
    // the alias is only a name.
    const reference = parent.propertyName ?? parent.name;
    return reference === node && !parent.isTypeOnly && !parent.parent.parent.isTypeOnly
      ? names
      : [];
  }
  if (parent.name === node || parent.propertyName === node || inTypePosition(node)) return [];
  return names;
}

/**
 * Every use of a {@link TOKEN_MOVEMENT_BUILDERS} rule outside its list, and
 * every listed file that no longer uses it.
 *
 * @param {{ rootDir: string, rules: BuilderRule[], files: string[] }} input
 *   `files` are repo paths to scan; test files are skipped.
 * @returns {string[]} One message per violation.
 */
export function findTokenMovementBuilderViolations({ rootDir, rules, files }) {
  const violations = [];
  const used = new Set();
  for (const file of files) {
    if (!/\.(ts|tsx|mts)$/.test(file) || isTestFile(file)) continue;
    const text = readFileSync(path.join(rootDir, file), "utf8");
    if (
      !rules.some((rule) =>
        rule.imports.some(({ packages }) => packages.some((pkg) => text.includes(pkg)))
      )
    ) {
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const rule of rules) {
      const named = rule.imports.flatMap(({ packages, names }) =>
        packages.flatMap((pkg) => importedNames(source, pkg, names))
      );
      if (named.length === 0) continue;
      if (rule.allow.includes(file)) used.add(`${rule.id} ${file}`);
      else violations.push(`${file} uses ${named.join(", ")}: it ${rule.why} (${rule.id})`);
    }
  }
  for (const rule of rules) {
    for (const file of rule.allow) {
      if (!used.has(`${rule.id} ${file}`))
        violations.push(`${file} no longer uses ${rule.id}: remove it from the list`);
    }
  }
  return violations;
}

/** A tsconfig's root files and compiler options. */
function parseTsconfig(tsconfig) {
  const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfig));
}

/**
 * The last program built and its tsconfig. Both checks start from the API's
 * program, so it is built once; holding every program at once would pass the
 * default heap.
 */
let lastProgram = { tsconfig: undefined, program: undefined };

/** The TypeScript program a tsconfig describes. */
function programFor(tsconfig) {
  if (lastProgram.tsconfig !== tsconfig) {
    const parsed = parseTsconfig(tsconfig);
    lastProgram = {
      tsconfig,
      program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
    };
  }
  return lastProgram.program;
}

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
function resolveModuleSource(program, specifier, containingFile) {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    program.getCompilerOptions(),
    ts.sys
  ).resolvedModule;
  return resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
}

/**
 * The file a capability's `module` symbols resolve from: the first program source file under its
 * first owner directory, or the program's first root file for a capability every workspace may
 * import (no owners).
 */
function ownerSourceFile(program, rootDir, capability) {
  if (capability.owners.length === 0) {
    return program.getRootFileNames()[0];
  }
  const ownerDir = path.join(rootDir, capability.owners[0], "/");
  const source = program.getSourceFiles().find((file) => file.fileName.startsWith(ownerDir));
  if (!source) {
    throw new Error(
      `Capability ${capability.id} owner ${capability.owners[0]} has no file in the program`
    );
  }
  return source.fileName;
}

/**
 * Resolves a capability's declared symbols in the program (`name: "*"` is every value export).
 * A `module` symbol is resolved from a source file inside the capability's first owner, since
 * only the owner declares the dependency and pnpm's strict `node_modules` hides it everywhere else.
 */
function resolveSymbol(checker, program, rootDir, capability, capabilitySymbol) {
  const source = capabilitySymbol.module
    ? resolveModuleSource(
        program,
        capabilitySymbol.module,
        ownerSourceFile(program, rootDir, capability)
      )
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
  const program = programFor(tsconfig);
  const checker = program.getTypeChecker();

  const targets = new Map();
  for (const capability of capabilities) {
    for (const capabilitySymbol of capability.symbols) {
      for (const symbol of resolveSymbol(checker, program, rootDir, capability, capabilitySymbol)) {
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

/** The repo-relative path of a program source file, with forward slashes. */
function repoPath(rootDir, fileName) {
  return path.relative(rootDir, fileName).split(path.sep).join("/");
}

/** The type symbol a type node names, through import aliases; undefined for anything else. */
function namedTypeSymbol(checker, node) {
  let named;
  if (ts.isTypeReferenceNode(node)) {
    named = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
  } else if (ts.isExpressionWithTypeArguments(node)) {
    // An `extends` or `implements` clause names its type as an expression.
    named = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  } else if (ts.isImportTypeNode(node) || ts.isTypeQueryNode(node)) {
    return checker.getTypeFromTypeNode(node).aliasSymbol;
  } else {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(named);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/**
 * The nodes a named type is made of: an alias's type, an interface's heritage
 * and members, and a class's heritage and member types (not its code).
 * Declaration files cannot name a brand they do not import, so they are skipped.
 */
function typeDeclarationParts(symbol) {
  const parts = [];
  for (const declaration of symbol.declarations ?? []) {
    const inSource = !declaration.getSourceFile().isDeclarationFile;
    if (ts.isTypeAliasDeclaration(declaration)) {
      parts.push(declaration.type);
    } else if (inSource && ts.isInterfaceDeclaration(declaration)) {
      parts.push(declaration);
    } else if (inSource && ts.isClassDeclaration(declaration)) {
      parts.push(...(declaration.heritageClauses ?? []));
      for (const member of declaration.members) {
        if (member.type) parts.push(member.type);
      }
    }
  }
  return parts;
}

/**
 * The branded type a type node names, directly or through a local type alias,
 * a type argument, a union or an object member; or undefined.
 */
function brandedTypeIn(checker, typeNode, targets) {
  const seen = new Set();
  const visit = (node) => {
    const symbol = namedTypeSymbol(checker, node);
    if (symbol && targets.has(symbol)) return targets.get(symbol);
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      for (const part of typeDeclarationParts(symbol)) {
        const found = ts.isTypeNode(part) ? visit(part) : ts.forEachChild(part, visit);
        if (found) return found;
      }
    }
    return ts.forEachChild(node, visit);
  };
  return visit(typeNode);
}

/** How deep the check looks into a type's elements and fields for a branded type. */
const CONTAINER_DEPTH = 3;

/**
 * The branded type a resolved type is, one member of the union it is, or holds
 * in an element, a type argument or a field (`TokenAmount[]`, `Promise<Quote>`,
 * `{ amount: TokenAmount }`); or undefined. It catches what no type node names,
 * such as `ReturnType<typeof f>`, and a cast of the whole container.
 */
function brandedTypeOf(checker, type, targets, depth = 0, seen = new Set()) {
  if (seen.has(type)) return undefined;
  seen.add(type);
  const members = type.isUnion() ? type.types : [];
  for (const candidate of [type, ...members]) {
    const brandedType = targets.get(candidate.aliasSymbol) ?? targets.get(candidate.symbol);
    if (brandedType) return brandedType;
  }
  if (depth >= CONTAINER_DEPTH) return undefined;
  for (const candidate of members.length > 0 ? members : [type]) {
    for (const part of containedTypes(checker, candidate)) {
      const brandedType = brandedTypeOf(checker, part, targets, depth + 1, seen);
      if (brandedType) return brandedType;
    }
  }
  return undefined;
}

/**
 * What a type holds: a generic type's arguments (arrays, tuples, `Promise`,
 * `Map`), or an object's fields and index signatures. A function holds none.
 */
function containedTypes(checker, type) {
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length > 0) return [];
  if (type.objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(type).length > 0) {
    return checker.getTypeArguments(type);
  }
  return [
    ...checker.getIndexInfosOfType(type).map((info) => info.type),
    ...type.getProperties().map((property) => checker.getTypeOfSymbol(property)),
  ];
}

/**
 * The branded types a program loads, by their type symbol. A program that does
 * not load a branded type's file cannot name the type.
 */
function brandedTargets(program, rootDir, brandedTypes) {
  const checker = program.getTypeChecker();
  const targets = new Map();
  for (const brandedType of brandedTypes) {
    const source = program.getSourceFile(path.join(rootDir, brandedType.file));
    if (!source) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exported = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol).find((s) => s.name === brandedType.name)
      : undefined;
    if (!exported || !(exported.flags & ts.SymbolFlags.Type)) {
      throw new Error(`${brandedType.file} does not export the type ${brandedType.name}`);
    }
    targets.set(exported, brandedType);
  }
  return targets;
}

/** Every assertion in one file to a branded type the file does not define. */
function brandedCastsIn(checker, source, relativePath, targets) {
  const violations = [];
  const visit = (node) => {
    const assertion = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
    if (assertion && !ts.isConstTypeReference(node.type)) {
      const asserted = checker.getTypeFromTypeNode(node.type);
      // `as never` and `as any` fit every type, so the forged type is the one the value lands in.
      const landsIn =
        asserted.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)
          ? checker.getContextualType(node)
          : undefined;
      const brandedType =
        brandedTypeIn(checker, node.type, targets) ??
        brandedTypeOf(checker, asserted, targets) ??
        (landsIn ? brandedTypeOf(checker, landsIn, targets) : undefined);
      if (brandedType && brandedType.file !== relativePath) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${relativePath}:${line + 1}: asserts ${brandedType.name} (${node.type.getText(source)}). Make it through ${brandedType.file}, never a cast: a cast skips its checks (ADR 0012).`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/**
 * Finds every `as T` and `<T>` assertion to a branded type, and every
 * `as never` or `as any` that lands in one, outside the type's defining file
 * and tests. Each tsconfig is its own program; a file two programs load is
 * checked once.
 *
 * @param {{ rootDir: string, tsconfigs: string[], brandedTypes: BrandedType[], scanRoots: string[] }} options
 */
export function findBrandedCastViolations({ rootDir, tsconfigs, brandedTypes, scanRoots }) {
  for (const [name, value] of Object.entries({ rootDir, tsconfigs, brandedTypes, scanRoots })) {
    if (value === undefined) throw new Error(`findBrandedCastViolations needs ${name}`);
  }
  const violations = [];
  const scanned = new Set();
  const declared = new Set();
  const unscanned = (relativePath) =>
    !relativePath.startsWith("..") &&
    !relativePath.includes("node_modules/") &&
    scanRoots.some((scanRoot) => relativePath.startsWith(scanRoot)) &&
    !isTestFile(relativePath) &&
    !scanned.has(relativePath);
  for (const tsconfig of tsconfigs) {
    // A workspace whose every file an earlier program checked needs no program.
    const rootFiles = parseTsconfig(tsconfig).fileNames.map((name) => repoPath(rootDir, name));
    if (!rootFiles.some(unscanned)) continue;
    const program = programFor(tsconfig);
    const targets = brandedTargets(program, rootDir, brandedTypes);
    if (targets.size === 0) continue;
    for (const brandedType of targets.values()) declared.add(brandedType);
    for (const source of program.getSourceFiles()) {
      const relativePath = repoPath(rootDir, source.fileName);
      if (source.isDeclarationFile || !unscanned(relativePath)) continue;
      scanned.add(relativePath);
      violations.push(...brandedCastsIn(program.getTypeChecker(), source, relativePath, targets));
    }
  }
  for (const brandedType of brandedTypes) {
    if (!declared.has(brandedType)) {
      throw new Error(`No program loads ${brandedType.file}, so ${brandedType.name} is unchecked`);
    }
  }
  return violations;
}

/**
 * The tsconfig of every workspace the cast ban scans: the API, the dashboard,
 * and each package with a tsconfig. Packages the API or the dashboard load
 * are scanned once, in the first program that loads them.
 */
function castScanTsconfigs(rootDir) {
  const packages = readdirSync(path.join(rootDir, "packages"))
    .map((name) => path.join(rootDir, "packages", name, "tsconfig.json"))
    .filter((tsconfig) => existsSync(tsconfig))
    .sort();
  return [
    path.join(rootDir, "apps/sdp-api/tsconfig.json"),
    path.join(rootDir, "apps/sdp-web/tsconfig.json"),
    ...packages,
  ];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const rootDir = REPO_ROOT;
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
  const castViolations = findBrandedCastViolations({
    rootDir,
    tsconfigs: castScanTsconfigs(rootDir),
    brandedTypes: BRANDED_TYPES,
    scanRoots: [`${API}/`, "apps/sdp-web/", "packages/"],
  });
  const builderViolations = findTokenMovementBuilderViolations({
    rootDir,
    rules: TOKEN_MOVEMENT_BUILDERS,
    files: execFileSync("git", ["ls-files", `${API}/`, "apps/sdp-web/", "packages/"], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  });
  if (builderViolations.length > 0) {
    console.error("Token movement builder check failed (ADR 0012):");
    for (const violation of builderViolations) console.error(`  ${violation}`);
  }
  if (violations.length > 0) {
    console.error("Value movement check failed (HOO-1955):");
    for (const violation of violations) console.error(`  ${violation}`);
  }
  if (castViolations.length > 0) {
    console.error("Token amount cast check failed (ADR 0012):");
    for (const violation of castViolations) console.error(`  ${violation}`);
  }
  if (violations.length > 0 || castViolations.length > 0 || builderViolations.length > 0) {
    process.exit(1);
  }
  console.log("Value movement check passed.");
}
