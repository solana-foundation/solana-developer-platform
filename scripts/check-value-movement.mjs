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
 * It also pins who may build a token movement (ADR 0012, decisions 7 and 8).
 * The builder (`@sdp/solana/token-movement`) is the one place SDP builds a
 * token transfer; each other path is a registered adapter with its own
 * capability row. So the `token-movement-*` capabilities pin every transfer
 * builder of the token programs, Solana Pay, Mosaic and the subscriptions
 * program, SPC's unchecked `Transfer`, Mosaic's conversion of a JS number, and
 * the Token-2022 client's display math, which Token Terms replaces. Each
 * allowlist names the builder or an adapter, with its reason. A third-party
 * package resolves from a workspace that declares it, and every workspace must
 * resolve it to that same copy, so a version split fails instead of unpinning
 * it. These capabilities also scan the dashboard and the packages it loads.
 *
 * It also bans casts to the token-movement amount types (ADR 0012, token
 * movements): `BaseUnits`, `TokenAmount`, `DisplayAmount`, `MovementQuote`,
 * `MovementIntent` and `AssetRef`. Their constructors check the u64 range, the
 * mint's scale and `debit = credit + fee`; an `as` or `<T>` assertion skips
 * them, and so does an `as never` or `as any` that lands in one. Only each
 * type's defining module may assert it, and tests are free.
 *
 * It also keeps the RPC's display values inside the RPC layer (ADR 0012):
 * `uiAmount` and `uiAmountString` on Kit's `TokenAmount` (`@solana/rpc-types`)
 * apply a mint's multiplier or interest as an f64. Outside
 * `packages/sdp-rpc/src/`, no code may read them (property, literal element
 * access, destructuring) or set them in an object typed against them. These
 * last two parts scan the API, the dashboard and every package.
 *
 * Adding a file or a symbol to any list below is a security-reviewed change.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const API = "apps/sdp-api/src";
const SOLANA = "packages/sdp-solana/src";
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

/**
 * A pinned symbol: `name` exported by the file `file` or the package `module`
 * (`name: "*"` is every callable it exports). A `module` resolves from
 * `resolveFrom`, a workspace directory that declares it, when set; otherwise
 * from the capability's first owner, or the program's first root file when it
 * has no owners.
 *
 * @typedef {{ file?: string, module?: string, resolveFrom?: string, name: string }} CapabilitySymbol
 */
/**
 * @typedef {{
 *   id: string,
 *   why: string,
 *   symbols: CapabilitySymbol[],
 *   owners: string[],
 *   allow: string[],
 * }} Capability
 */

const TOKEN = "@solana-program/token";
const TOKEN_2022 = "@solana-program/token-2022";
const MOSAIC = "@solana/mosaic-sdk";
const SUBSCRIPTIONS = "@solana/subscriptions";
const SOLANA_PAY = "@solana/pay";

/**
 * `names`, exported by `module`, resolved from the API: it declares every
 * package below, and the dashboard declares none of them.
 *
 * @returns {CapabilitySymbol[]}
 */
function apiModuleSymbols(module, names) {
  return names.map((name) => ({ module, name, resolveFrom: "apps/sdp-api" }));
}

// biome-ignore-start lint/security/noSecrets: SDK and function names, not secrets.
/**
 * Who may build a token movement (ADR 0012, decisions 7 and 8). These are
 * third-party builders, so no package owns them.
 *
 * @type {Capability[]}
 */
export const TOKEN_MOVEMENT_CAPABILITIES = [
  {
    id: "token-movement-transfer",
    why: "Builds a token transfer; only the token movement builder and the registered adapters may (ADR 0012, decisions 7 and 8).",
    symbols: [
      ...apiModuleSymbols(TOKEN, [
        "getTransferCheckedInstruction",
        // Each opens the destination's account and transfers with `TransferChecked`.
        "getTransferToATAInstructionPlan",
        "getTransferToATAInstructionPlanAsync",
        // The client plugin hands every builder above out as a method.
        "tokenProgram",
      ]),
      ...apiModuleSymbols(TOKEN_2022, [
        "getTransferCheckedInstruction",
        "getTransferCheckedWithFeeInstruction",
        "getTransferCheckedWithTransferHookInstructionAsync",
        "getTransferToATAInstructionPlan",
        "getTransferToATAInstructionPlanAsync",
        "token2022Program",
      ]),
      // A transfer from a decimal amount it converts itself. The API keeps the
      // package for `encodeURL`; /pay builds with `buildTokenMovement`.
      ...apiModuleSymbols(SOLANA_PAY, ["createTransfer"]),
    ],
    owners: [],
    allow: [
      // The builder: `TransferCheckedWithFee` when the mint has a fee config, else `TransferChecked`.
      `${SOLANA}/token-movement.ts`,
      // SPC's Token-2022 `TransferChecked`; the `private_channels` row refuses fee and hook mints.
      `${API}/services/private-channels/transfer.ts`,
      // Moves the owner's classic kvault share tokens into its ATA, and asserts a burn-all balance with a self-transfer.
      "packages/sdp-kamino/src/withdraw-instructions.ts",
      // WisdomTree's deposit and redemption legs: its resolver adds the fund's compliance hook accounts, and Earn's row decides the deposit mint.
      "packages/sdp-wisdomtree/src/plan.ts",
    ],
  },
  {
    id: "token-movement-unchecked-transfer",
    why: "Builds the unchecked `Transfer`, which names no mint or decimals, so a fee settles short; the builder never uses it (ADR 0012, decision 7).",
    symbols: [
      ...apiModuleSymbols(TOKEN, ["getTransferInstruction"]),
      ...apiModuleSymbols(TOKEN_2022, ["getTransferInstruction"]),
      // SPC's transfer builder, which wraps the classic `Transfer`.
      {
        file: `${API}/services/private-channels/transfer.ts`,
        name: "buildTokenTransferInstructions",
      },
    ],
    owners: [],
    allow: [
      // SPC checks instruction bytes against its program allowlist, so a classic mint keeps the byte-identical `Transfer`; the `private_channels` row refuses fee and hook mints.
      `${API}/services/private-channels/transfer.ts`,
    ],
  },
  {
    id: "token-movement-mosaic",
    why: "Mosaic mints, burns or moves tokens from a JS number it converts itself; only the issuance adapter may, with a number checked to give back the amount's base units (ADR 0012, Adapters).",
    symbols: apiModuleSymbols(MOSAIC, [
      "createMintToTransaction",
      "createBurnTransaction",
      "createPermissionedBurnTransaction",
      "createForceBurnTransaction",
      "createForceTransferTransaction",
      "createTransferInstructions",
      "createTransferTransaction",
      // The fund-lock operations: each mints, moves or burns a lock account's balance.
      "createMintLockTransaction",
      "createBurnLockTransaction",
      "createSettleMintLockTransaction",
      "createCancelMintLockTransaction",
      "createSettleBurnLockTransaction",
      "createCancelBurnLockTransaction",
      // Mosaic's own conversion of that number.
      "decimalAmountToRaw",
    ]),
    owners: [],
    allow: [
      // Mint, seize (force transfer) and force burn, each amount from `mosaicAmountUnderLiveTerms`.
      "packages/sdp-issuance/src/mosaic/service.ts",
      // Burn, its amount from `mosaicAmountUnderLiveTerms`.
      `${SOLANA}/token-2022.ts`,
      // Checks that Mosaic's conversion gives back exactly the amount's base units.
      `${SOLANA}/mosaic-amount.ts`,
    ],
  },
  {
    id: "token-movement-recurring",
    why: "Builds a subscriptions-program pull, which the program moves with plain `TransferChecked`, or writes the base-unit amount it pulls later; only the recurring adapter may (ADR 0012, decision 9).",
    symbols: apiModuleSymbols(SUBSCRIPTIONS, [
      // Pulls.
      "getTransferSubscriptionInstruction",
      "getTransferSubscriptionInstructionAsync",
      "getTransferSubscriptionOverlayInstructionAsync",
      "getTransferFixedInstruction",
      "getTransferFixedInstructionAsync",
      "getTransferFixedOverlayInstructionAsync",
      "getTransferRecurringInstruction",
      "getTransferRecurringInstructionAsync",
      "getTransferRecurringOverlayInstructionAsync",
      // Mandates: a plan's terms, a subscriber's expected amount, a delegation's cap.
      // `UpdatePlan` is not here: it changes a plan's status, end and pullers, never its amount or mint.
      "getCreatePlanInstruction",
      "getCreatePlanOverlayInstructionAsync",
      "getSubscribeInstruction",
      "getSubscribeInstructionAsync",
      "getSubscribeOverlayInstructionAsync",
      "getCreateFixedDelegationInstruction",
      "getCreateFixedDelegationOverlayInstructionAsync",
      "getCreateRecurringDelegationInstruction",
      "getCreateRecurringDelegationOverlayInstructionAsync",
      // The client plugin hands every builder of the program out as a method.
      "subscriptionsProgram",
    ]),
    owners: [],
    allow: [
      // The collection job's pull, after it reads the terms again and checks the fee tolerance.
      `${API}/services/payments/recurring-payments/collection.ts`,
      // Activation creates the plan and subscribes, from the stored debit mandate.
      `${API}/services/payments/recurring-payments/activation.ts`,
      // A terms change creates the new plan and subscribes to it, from the new mandate.
      `${API}/services/payments/recurring-payments/update.ts`,
      // The plan route creates a merchant plan from the plan row's mandate.
      `${API}/routes/payments/subscription-plans/handlers.ts`,
      // The subscribe route expects the plan's stored debit; the collect route builds an unsigned pull of it for the puller to sign.
      `${API}/routes/payments/subscriptions/handlers.ts`,
    ],
  },
  {
    id: "token-movement-display",
    why: "The Token-2022 client's display math, which does not match the program at the pinned version; Token Terms mirrors the program instead (ADR 0012, decision 4).",
    symbols: apiModuleSymbols(TOKEN_2022, [
      "amountToUiAmountForMintWithoutSimulation",
      "amountToUiAmountForInterestBearingMintWithoutSimulation",
      "amountToUiAmountForScaledUiAmountMintWithoutSimulation",
      "uiAmountToAmountForMintWithoutSimulation",
      "uiAmountToAmountForInterestBearingMintWithoutSimulation",
      "uiAmountToAmountForScaledUiAmountMintWithoutSimulation",
      // The program's own conversion, by simulation: the mint matrix's reference, never a flow's.
      "getAmountToUiAmountInstruction",
      "getUiAmountToAmountInstruction",
    ]),
    owners: [],
    allow: [],
  },
];
// biome-ignore-end lint/security/noSecrets: SDK and function names, not secrets.

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
  ...TOKEN_MOVEMENT_CAPABILITIES,
];

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
  { file: `${SOLANA}/token-terms.ts`, name: "DisplayAmount" },
  { file: `${SOLANA}/movement-quote.ts`, name: "MovementQuote" },
  { file: `${SOLANA}/movement-quote.ts`, name: "MovementIntent" },
  { file: `${SOLANA}/asset-ref.ts`, name: "AssetRef" },
];

/** A tsconfig's root files and compiler options. */
function parseTsconfig(tsconfig) {
  const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfig));
}

/**
 * The last program built and its tsconfig. Holding every program at once would
 * pass the default heap, so the checks order their programs to reuse it: the
 * capability check ends on the API's program, where the file checks start.
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

/** The repo-relative path of a program source file, with forward slashes. */
function repoPath(rootDir, fileName) {
  return path.relative(rootDir, fileName).split(path.sep).join("/");
}

/**
 * The file a capability's `module` symbols resolve from without `resolveFrom`:
 * the first program source file under its first owner directory, or the
 * program's first root file for a capability every workspace may import (no
 * owners).
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
 * The file a `module` symbol resolves to, the way the program resolves it.
 * pnpm's strict `node_modules` hides a package from every workspace that does
 * not declare it, so it resolves from `resolveFrom` or the capability's owner.
 */
function moduleFileName(program, rootDir, capability, capabilitySymbol) {
  const resolveFrom = capabilitySymbol.resolveFrom;
  const containingFile =
    resolveFrom === undefined
      ? ownerSourceFile(program, rootDir, capability)
      : path.join(rootDir, resolveFrom, "package.json");
  if (resolveFrom !== undefined && !existsSync(containingFile)) {
    throw new Error(
      `Capability ${capability.id} resolves from ${resolveFrom}, which has no package.json`
    );
  }
  const resolved = ts.resolveModuleName(
    capabilitySymbol.module,
    containingFile,
    program.getCompilerOptions(),
    ts.sys
  ).resolvedModule;
  if (!resolved) {
    throw new Error(
      `Capability ${capability.id} cannot resolve ${capabilitySymbol.module} from ${repoPath(rootDir, containingFile)}`
    );
  }
  return resolved.resolvedFileName;
}

/**
 * Resolves a capability's declared symbols in the program (`name: "*"` is every
 * value export). A symbol whose file the program does not load resolves to
 * none: no file in that program can reference it. `moduleFile` is the file a
 * `module` symbol resolves to, loaded or not, and null for a `file` symbol.
 *
 * @returns {{ symbols: ts.Symbol[], moduleFile: string | null }}
 */
function resolveSymbol(checker, program, rootDir, capability, capabilitySymbol) {
  const moduleFile = capabilitySymbol.module
    ? moduleFileName(program, rootDir, capability, capabilitySymbol)
    : null;
  const source = program.getSourceFile(
    moduleFile === null ? path.join(rootDir, capabilitySymbol.file) : moduleFile
  );
  if (!source) return { symbols: [], moduleFile };
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
    return { symbols: values, moduleFile };
  }
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.name === capabilitySymbol.name)
    : undefined;
  if (!exported) {
    throw new Error(
      `${capabilitySymbol.module ?? capabilitySymbol.file} does not export ${capabilitySymbol.name}`
    );
  }
  return { symbols: [resolve(exported)], moduleFile };
}

/** The literal specifier of a value import, export, `import()` or `require()`; else undefined. */
function valueModuleSpecifier(node) {
  let specifier;
  if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
    specifier = node.moduleSpecifier;
  } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
    specifier = node.moduleSpecifier;
  } else if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    specifier = node.arguments[0];
  }
  return specifier && ts.isStringLiteralLike(specifier) ? specifier : undefined;
}

/**
 * Every reference in one file to a capability in `pending`, and every import
 * of a pinned package that resolves to another copy than the pinned one.
 * Records each allowlisted use in `used`.
 */
function capabilityViolationsIn({
  checker,
  rootDir,
  source,
  relativePath,
  targets,
  pending,
  pinnedModules,
  used,
}) {
  const violations = [];
  // Namespace imports in this file that carry a pinned constructor. An
  // allowlisted file may call through one (`ns.Adapter(...)`), but not hand
  // the namespace itself on or index it with a computed name.
  const pinnedNamespaces = new Set();
  const report = (node, symbol, label, viaModule) => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const capability = symbol ? targets.get(symbol) : undefined;
    if (!capability || !pending.has(capability)) return;
    // A defining package may use its own constructors however it likes.
    if (capability.owners.some((owner) => owner.endsWith("/") && relativePath.startsWith(owner))) {
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
  // A pinned package imported from another copy (a workspace that declares
  // another version) carries constructors the check never resolved.
  const reportOtherCopy = (specifier) => {
    const pinned = pinnedModules.get(specifier.text);
    if (pinned === undefined) return;
    const resolved = checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
    if (resolved?.fileName === pinned) return;
    const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
    violations.push(
      `${relativePath}:${line + 1}: imports a copy of ${specifier.text} the check does not pin (${resolved ? repoPath(rootDir, resolved.fileName) : "unresolved"}); every workspace must resolve it to ${repoPath(rootDir, pinned)}.`
    );
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
    const specifier = valueModuleSpecifier(node);
    if (specifier) reportOtherCopy(specifier);
    if (isOpaqueCodeLoad(checker, node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(
        `${relativePath}:${line + 1}: loads code the check cannot follow (a computed import, require, createRequire, eval or Function); name the module literally.`
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/**
 * Finds every capability reference outside its allowlist, and every stale
 * allowlist entry. Each program checks its own capabilities over its scan
 * roots. A file two programs load is checked once per capability, in the first
 * program that checks it: its references resolve the same in either, because
 * every pinned package must resolve to one copy. Returns human-readable
 * violations.
 *
 * @param {{
 *   rootDir: string,
 *   programs: { tsconfig: string, scanRoots: string[], capabilities: Capability[] }[],
 * }} options
 */
export function findValueMovementViolations({ rootDir, programs }) {
  for (const [name, value] of Object.entries({ rootDir, programs })) {
    if (value === undefined) throw new Error(`findValueMovementViolations needs ${name}`);
  }
  const capabilities = [...new Set(programs.flatMap((scan) => scan.capabilities))];
  const used = new Map(capabilities.map((capability) => [capability.id, new Set()]));
  /** Each declared symbol some program loads; one that none loads is checked nowhere. */
  const loaded = new Set();
  /** The capabilities each file was already checked against. */
  const checked = new Map();
  const violations = [];
  for (const scan of programs) {
    const program = programFor(scan.tsconfig);
    const checker = program.getTypeChecker();
    const { targets, pinnedModules } = resolveTargets({
      checker,
      program,
      rootDir,
      capabilities: scan.capabilities,
      loaded,
    });
    for (const source of program.getSourceFiles()) {
      const relativePath = scannedPath(rootDir, source, scan.scanRoots);
      if (relativePath === null) continue;
      if (!checked.has(relativePath)) checked.set(relativePath, new Set());
      const done = checked.get(relativePath);
      const pending = new Set(scan.capabilities.filter((capability) => !done.has(capability)));
      if (pending.size === 0) continue;
      for (const capability of pending) done.add(capability);
      violations.push(
        ...capabilityViolationsIn({
          checker,
          rootDir,
          source,
          relativePath,
          targets,
          pending,
          pinnedModules,
          used,
        })
      );
    }
  }
  violations.push(...staleAllowEntries(capabilities, loaded, used));
  // A file two programs check repeats its code-load and copy findings.
  return [...new Set(violations)];
}

/**
 * The program's pinned symbols, by symbol, and each pinned package's specifier
 * with the file the check resolved it to. Adds each declared symbol the
 * program loads to `loaded`.
 */
function resolveTargets({ checker, program, rootDir, capabilities, loaded }) {
  const targets = new Map();
  const pinnedModules = new Map();
  for (const capability of capabilities) {
    for (const capabilitySymbol of capability.symbols) {
      const { symbols, moduleFile } = resolveSymbol(
        checker,
        program,
        rootDir,
        capability,
        capabilitySymbol
      );
      const pinned = pinnedModules.get(capabilitySymbol.module);
      if (moduleFile !== null && pinned !== undefined && pinned !== moduleFile) {
        throw new Error(
          `${capabilitySymbol.module} resolves to ${repoPath(rootDir, pinned)} and ${repoPath(rootDir, moduleFile)}; pin one copy`
        );
      }
      if (moduleFile !== null) pinnedModules.set(capabilitySymbol.module, moduleFile);
      if (symbols.length > 0) loaded.add(capabilitySymbol);
      for (const symbol of symbols) targets.set(symbol, capability);
    }
  }
  return { targets, pinnedModules };
}

/** A source file's repo path when it is under a scan root and not a test; else null. */
function scannedPath(rootDir, source, scanRoots) {
  if (source.isDeclarationFile) return null;
  const relativePath = repoPath(rootDir, source.fileName);
  const scanned =
    !relativePath.startsWith("..") &&
    !relativePath.includes("node_modules/") &&
    scanRoots.some((scanRoot) => relativePath.startsWith(scanRoot)) &&
    !isTestFile(relativePath);
  return scanned ? relativePath : null;
}

/**
 * Every allowlist entry that no longer references its capability. Throws for
 * a declared symbol no program loads, which nothing would check.
 */
function staleAllowEntries(capabilities, loaded, used) {
  const stale = [];
  for (const capability of capabilities) {
    const unloaded = capability.symbols.find((capabilitySymbol) => !loaded.has(capabilitySymbol));
    if (unloaded) {
      throw new Error(
        `No program loads ${unloaded.module ?? unloaded.file}, so ${capability.id} cannot pin ${unloaded.name}`
      );
    }
    for (const allowed of capability.allow) {
      if (!used.get(capability.id).has(allowed)) {
        stale.push(
          `${allowed}: no longer references ${capability.id}; remove it from the allowlist (the list only shrinks).`
        );
      }
    }
  }
  return stale;
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

/**
 * The branded type a resolved type is, or one member of the union it is; or
 * undefined. It catches what no type node names, such as `ReturnType<typeof f>`.
 */
function brandedTypeOf(type, targets) {
  for (const candidate of [type, ...(type.isUnion() ? type.types : [])]) {
    const brandedType = targets.get(candidate.aliasSymbol) ?? targets.get(candidate.symbol);
    if (brandedType) return brandedType;
  }
  return undefined;
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
        brandedTypeOf(asserted, targets) ??
        (landsIn ? brandedTypeOf(landsIn, targets) : undefined);
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
 * A check of single files over several programs. `forProgram` returns the
 * program's file visitor, or null when the program loads nothing the check
 * looks for; `finish` throws for what no program let it check.
 *
 * @typedef {{
 *   forProgram: (program: ts.Program) => ((source: ts.SourceFile, relativePath: string) => string[]) | null,
 *   finish: () => void,
 *   violations: string[],
 *   scanned: Set<string>,
 * }} FileCheck
 */

/**
 * Runs `checks` over each tsconfig's program. A file is checked once per
 * check, in the first program that loads it and gives that check a visitor. A
 * workspace whose every file each check already checked needs no program.
 * Tests are free.
 *
 * @param {{ rootDir: string, tsconfigs: string[], scanRoots: string[], checks: FileCheck[] }} options
 */
export function runFileChecks({ rootDir, tsconfigs, scanRoots, checks }) {
  for (const [name, value] of Object.entries({ rootDir, tsconfigs, scanRoots, checks })) {
    if (value === undefined) throw new Error(`runFileChecks needs ${name}`);
  }
  const inScope = (relativePath) =>
    !relativePath.startsWith("..") &&
    !relativePath.includes("node_modules/") &&
    scanRoots.some((scanRoot) => relativePath.startsWith(scanRoot)) &&
    !isTestFile(relativePath);
  for (const tsconfig of tsconfigs) {
    const rootFiles = parseTsconfig(tsconfig)
      .fileNames.map((name) => repoPath(rootDir, name))
      .filter(inScope);
    if (checks.every((check) => rootFiles.every((file) => check.scanned.has(file)))) continue;
    const program = programFor(tsconfig);
    const visitors = checks
      .map((check) => ({ check, visit: check.forProgram(program) }))
      .filter(({ visit }) => visit !== null);
    for (const source of program.getSourceFiles()) {
      const relativePath = repoPath(rootDir, source.fileName);
      if (source.isDeclarationFile || !inScope(relativePath)) continue;
      for (const { check, visit } of visitors) {
        if (check.scanned.has(relativePath)) continue;
        check.scanned.add(relativePath);
        check.violations.push(...visit(source, relativePath));
      }
    }
  }
  for (const check of checks) check.finish();
}

/**
 * The cast ban: every `as T` and `<T>` assertion to a branded type, and every
 * `as never` or `as any` that lands in one, outside the type's defining file.
 *
 * @returns {FileCheck}
 */
export function brandedCastCheck({ rootDir, brandedTypes }) {
  const declared = new Set();
  return {
    violations: [],
    scanned: new Set(),
    forProgram(program) {
      const targets = brandedTargets(program, rootDir, brandedTypes);
      if (targets.size === 0) return null;
      for (const brandedType of targets.values()) declared.add(brandedType);
      const checker = program.getTypeChecker();
      return (source, relativePath) => brandedCastsIn(checker, source, relativePath, targets);
    },
    finish() {
      for (const brandedType of brandedTypes) {
        if (!declared.has(brandedType)) {
          throw new Error(
            `No program loads ${brandedType.file}, so ${brandedType.name} is unchecked`
          );
        }
      }
    },
  };
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
  const check = brandedCastCheck({ rootDir, brandedTypes });
  runFileChecks({ rootDir, tsconfigs, scanRoots, checks: [check] });
  return check.violations;
}

/**
 * @typedef {{ declaredIn: string, names: string[], owner: string }} RpcDisplayValues
 */

/**
 * The RPC's display values, which never leave the RPC layer (ADR 0012).
 * `declaredIn` ends the path of Kit's `TokenAmount` in every installed copy of
 * `@solana/rpc-types`; `owner` is the RPC layer, which strips them.
 *
 * @type {RpcDisplayValues}
 */
export const RPC_DISPLAY_VALUES = {
  declaredIn: "/node_modules/@solana/rpc-types/dist/types/token-amount.d.ts",
  names: ["uiAmount", "uiAmountString"],
  owner: "packages/sdp-rpc/src/",
};

/** The text of a property name a reference spells out, or undefined for a computed one. */
function propertyNameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/**
 * The property a node reads or sets by a name it spells out: a property or
 * literal element access, a destructuring binding, or an object-literal
 * property. `type` gives the type the name is looked up on (the contextual
 * type for a literal, which may have none); else undefined.
 */
function displayFieldAccess(checker, node) {
  if (ts.isPropertyAccessExpression(node)) {
    return {
      name: node.name.text,
      at: node.name,
      type: () => checker.getTypeAtLocation(node.expression),
    };
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return {
      name: node.argumentExpression.text,
      at: node.argumentExpression,
      type: () => checker.getTypeAtLocation(node.expression),
    };
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const name = propertyNameText(node.propertyName ?? node.name);
    return name === undefined
      ? undefined
      : { name, at: node, type: () => checker.getTypeAtLocation(node.parent) };
  }
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent)
  ) {
    const name = propertyNameText(node.name);
    return name === undefined
      ? undefined
      : { name, at: node.name, type: () => checker.getContextualType(node.parent) };
  }
  return undefined;
}

/** Every reference in one file to a display value `fields` names. */
function rpcDisplayValuesIn(checker, source, relativePath, fields) {
  const names = new Set(fields.names);
  const declaredInRpcTypes = (symbol) =>
    symbol?.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.endsWith(fields.declaredIn)
    ) === true;
  // A union (`TokenAmount | undefined`, a parsed or narrowed shape) has the
  // field when one of its members does.
  const typeHasField = (type, name) =>
    (type.isUnion() ? type.types : [type]).some((member) =>
      declaredInRpcTypes(checker.getPropertyOfType(member, name))
    );
  const violations = [];
  const flag = (node, name) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(
      `${relativePath}:${line + 1}: references ${name}, the RPC's display value on Kit's TokenAmount. Display values stay in ${fields.owner} (ADR 0012): read the base units and apply Token Terms.`
    );
  };
  const visit = (node) => {
    const access = displayFieldAccess(checker, node);
    if (access && names.has(access.name)) {
      const type = access.type();
      if (type && typeHasField(type, access.name)) flag(access.at, access.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/**
 * The display-value ban: no reference to `fields` outside its owner.
 *
 * @param {{ fields: RpcDisplayValues }} options
 * @returns {FileCheck}
 */
export function rpcDisplayValueCheck({ fields }) {
  let declared = false;
  return {
    violations: [],
    scanned: new Set(),
    forProgram(program) {
      // A program that loads no copy of the type cannot reference its fields.
      if (!program.getSourceFiles().some((file) => file.fileName.endsWith(fields.declaredIn))) {
        return null;
      }
      declared = true;
      const checker = program.getTypeChecker();
      return (source, relativePath) =>
        relativePath.startsWith(fields.owner)
          ? []
          : rpcDisplayValuesIn(checker, source, relativePath, fields);
    },
    finish() {
      if (!declared) {
        throw new Error(
          `No program loads ${fields.declaredIn}, so its display values are unchecked`
        );
      }
    },
  };
}

/**
 * Finds every reference to the RPC's display values outside the RPC layer
 * and tests. Each tsconfig is its own program; a file two programs load is
 * checked once.
 *
 * @param {{ rootDir: string, tsconfigs: string[], fields: RpcDisplayValues, scanRoots: string[] }} options
 */
export function findRpcDisplayValueViolations({ rootDir, tsconfigs, fields, scanRoots }) {
  const check = rpcDisplayValueCheck({ fields });
  runFileChecks({ rootDir, tsconfigs, scanRoots, checks: [check] });
  return check.violations;
}

/**
 * The tsconfig of every workspace the file checks scan: the API, the
 * dashboard, and each package with a tsconfig. Packages the API or the
 * dashboard load are scanned once, in the first program that loads them.
 */
function fileCheckTsconfigs(rootDir) {
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
  const apiTsconfig = path.join(rootDir, "apps/sdp-api/tsconfig.json");
  const webTsconfig = path.join(rootDir, "apps/sdp-web/tsconfig.json");
  for (const tsconfig of [apiTsconfig, webTsconfig]) {
    if (!existsSync(tsconfig)) {
      console.error(`Missing ${tsconfig}`);
      process.exit(1);
    }
  }
  const violations = findValueMovementViolations({
    rootDir,
    programs: [
      // The dashboard and the packages it loads: the token-movement pins only,
      // since nothing there signs.
      {
        tsconfig: webTsconfig,
        scanRoots: ["apps/sdp-web/", "packages/"],
        capabilities: TOKEN_MOVEMENT_CAPABILITIES,
      },
      // The API and every package it loads: a package other than the defining
      // ones gets no more room than API code. Last, so the file checks below
      // start on its program.
      { tsconfig: apiTsconfig, scanRoots: [`${API}/`, "packages/"], capabilities: CAPABILITIES },
    ],
  });
  const castCheck = brandedCastCheck({ rootDir, brandedTypes: BRANDED_TYPES });
  const displayCheck = rpcDisplayValueCheck({ fields: RPC_DISPLAY_VALUES });
  runFileChecks({
    rootDir,
    tsconfigs: fileCheckTsconfigs(rootDir),
    scanRoots: [`${API}/`, "apps/sdp-web/", "packages/"],
    checks: [castCheck, displayCheck],
  });
  const failures = [
    ["Value movement check failed (HOO-1955):", violations],
    ["Token amount cast check failed (ADR 0012):", castCheck.violations],
    ["RPC display value check failed (ADR 0012):", displayCheck.violations],
  ].filter(([, found]) => found.length > 0);
  for (const [heading, found] of failures) {
    console.error(heading);
    for (const violation of found) console.error(`  ${violation}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
  console.log("Value movement check passed.");
}
