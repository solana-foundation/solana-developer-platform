// biome-ignore-all lint/security/noSecrets: Anchor's public error identifiers, not credentials
/**
 * Anchor's framework-level error codes (`anchor_lang::error::ErrorCode`), pinned
 * from @coral-xyz/anchor 0.31's `LangErrorMessage` (generated, do not hand-edit
 * the rows). They are raised by the framework AROUND a program, never by the
 * vault's own logic, so they name an integration or deployment defect rather
 * than a refusal: a wrong account, a constraint the client violated, or — code
 * 101 — an instruction the deployed build simply does not have (Kamino's devnet
 * kvault program answering a `deposit_with_min_shares_out` it predates).
 * Provider-defined codes start at 6000 and are read from the program's own log
 * line instead (`anchorErrorFromLogs`).
 */
export const ANCHOR_FRAMEWORK_ERRORS = new Map<number, { name: string; message: string }>([
  [100, { name: "InstructionMissing", message: "Instruction discriminator not provided" }],
  [101, { name: "InstructionFallbackNotFound", message: "Fallback functions are not supported" }],
  [
    102,
    {
      name: "InstructionDidNotDeserialize",
      message: "The program could not deserialize the given instruction",
    },
  ],
  [
    103,
    {
      name: "InstructionDidNotSerialize",
      message: "The program could not serialize the given instruction",
    },
  ],
  [
    1000,
    { name: "IdlInstructionStub", message: "The program was compiled without idl instructions" },
  ],
  [
    1001,
    {
      name: "IdlInstructionInvalidProgram",
      message: "The transaction was given an invalid program for the IDL instruction",
    },
  ],
  [
    1002,
    {
      name: "IdlAccountNotEmpty",
      message: "IDL account must be empty in order to resize, try closing first",
    },
  ],
  [
    1500,
    {
      name: "EventInstructionStub",
      message: "The program was compiled without `event-cpi` feature",
    },
  ],
  [2000, { name: "ConstraintMut", message: "A mut constraint was violated" }],
  [2001, { name: "ConstraintHasOne", message: "A has one constraint was violated" }],
  [2002, { name: "ConstraintSigner", message: "A signer constraint was violated" }],
  [2003, { name: "ConstraintRaw", message: "A raw constraint was violated" }],
  [2004, { name: "ConstraintOwner", message: "An owner constraint was violated" }],
  [2005, { name: "ConstraintRentExempt", message: "A rent exemption constraint was violated" }],
  [2006, { name: "ConstraintSeeds", message: "A seeds constraint was violated" }],
  [2007, { name: "ConstraintExecutable", message: "An executable constraint was violated" }],
  [
    2008,
    {
      name: "ConstraintState",
      message: "Deprecated Error, feel free to replace with something else",
    },
  ],
  [2009, { name: "ConstraintAssociated", message: "An associated constraint was violated" }],
  [
    2010,
    { name: "ConstraintAssociatedInit", message: "An associated init constraint was violated" },
  ],
  [2011, { name: "ConstraintClose", message: "A close constraint was violated" }],
  [2012, { name: "ConstraintAddress", message: "An address constraint was violated" }],
  [2013, { name: "ConstraintZero", message: "Expected zero account discriminant" }],
  [2014, { name: "ConstraintTokenMint", message: "A token mint constraint was violated" }],
  [2015, { name: "ConstraintTokenOwner", message: "A token owner constraint was violated" }],
  [
    2016,
    {
      name: "ConstraintMintMintAuthority",
      message: "A mint mint authority constraint was violated",
    },
  ],
  [
    2017,
    {
      name: "ConstraintMintFreezeAuthority",
      message: "A mint freeze authority constraint was violated",
    },
  ],
  [2018, { name: "ConstraintMintDecimals", message: "A mint decimals constraint was violated" }],
  [2019, { name: "ConstraintSpace", message: "A space constraint was violated" }],
  [
    2020,
    { name: "ConstraintAccountIsNone", message: "A required account for the constraint is None" },
  ],
  [
    2021,
    {
      name: "ConstraintTokenTokenProgram",
      message: "A token account token program constraint was violated",
    },
  ],
  [
    2022,
    { name: "ConstraintMintTokenProgram", message: "A mint token program constraint was violated" },
  ],
  [
    2023,
    {
      name: "ConstraintAssociatedTokenTokenProgram",
      message: "An associated token account token program constraint was violated",
    },
  ],
  [
    2024,
    {
      name: "ConstraintMintGroupPointerExtension",
      message: "A group pointer extension constraint was violated",
    },
  ],
  [
    2025,
    {
      name: "ConstraintMintGroupPointerExtensionAuthority",
      message: "A group pointer extension authority constraint was violated",
    },
  ],
  [
    2026,
    {
      name: "ConstraintMintGroupPointerExtensionGroupAddress",
      message: "A group pointer extension group address constraint was violated",
    },
  ],
  [
    2027,
    {
      name: "ConstraintMintGroupMemberPointerExtension",
      message: "A group member pointer extension constraint was violated",
    },
  ],
  [
    2028,
    {
      name: "ConstraintMintGroupMemberPointerExtensionAuthority",
      message: "A group member pointer extension authority constraint was violated",
    },
  ],
  [
    2029,
    {
      name: "ConstraintMintGroupMemberPointerExtensionMemberAddress",
      message: "A group member pointer extension group address constraint was violated",
    },
  ],
  [
    2030,
    {
      name: "ConstraintMintMetadataPointerExtension",
      message: "A metadata pointer extension constraint was violated",
    },
  ],
  [
    2031,
    {
      name: "ConstraintMintMetadataPointerExtensionAuthority",
      message: "A metadata pointer extension authority constraint was violated",
    },
  ],
  [
    2032,
    {
      name: "ConstraintMintMetadataPointerExtensionMetadataAddress",
      message: "A metadata pointer extension metadata address constraint was violated",
    },
  ],
  [
    2033,
    {
      name: "ConstraintMintCloseAuthorityExtension",
      message: "A close authority constraint was violated",
    },
  ],
  [
    2034,
    {
      name: "ConstraintMintCloseAuthorityExtensionAuthority",
      message: "A close authority extension authority constraint was violated",
    },
  ],
  [
    2035,
    {
      name: "ConstraintMintPermanentDelegateExtension",
      message: "A permanent delegate extension constraint was violated",
    },
  ],
  [
    2036,
    {
      name: "ConstraintMintPermanentDelegateExtensionDelegate",
      message: "A permanent delegate extension delegate constraint was violated",
    },
  ],
  [
    2037,
    {
      name: "ConstraintMintTransferHookExtension",
      message: "A transfer hook extension constraint was violated",
    },
  ],
  [
    2038,
    {
      name: "ConstraintMintTransferHookExtensionAuthority",
      message: "A transfer hook extension authority constraint was violated",
    },
  ],
  [
    2039,
    {
      name: "ConstraintMintTransferHookExtensionProgramId",
      message: "A transfer hook extension transfer hook program id constraint was violated",
    },
  ],
  [2500, { name: "RequireViolated", message: "A require expression was violated" }],
  [2501, { name: "RequireEqViolated", message: "A require_eq expression was violated" }],
  [2502, { name: "RequireKeysEqViolated", message: "A require_keys_eq expression was violated" }],
  [2503, { name: "RequireNeqViolated", message: "A require_neq expression was violated" }],
  [2504, { name: "RequireKeysNeqViolated", message: "A require_keys_neq expression was violated" }],
  [2505, { name: "RequireGtViolated", message: "A require_gt expression was violated" }],
  [2506, { name: "RequireGteViolated", message: "A require_gte expression was violated" }],
  [
    3000,
    {
      name: "AccountDiscriminatorAlreadySet",
      message: "The account discriminator was already set on this account",
    },
  ],
  [
    3001,
    { name: "AccountDiscriminatorNotFound", message: "No discriminator was found on the account" },
  ],
  [
    3002,
    {
      name: "AccountDiscriminatorMismatch",
      message: "Account discriminator did not match what was expected",
    },
  ],
  [3003, { name: "AccountDidNotDeserialize", message: "Failed to deserialize the account" }],
  [3004, { name: "AccountDidNotSerialize", message: "Failed to serialize the account" }],
  [
    3005,
    { name: "AccountNotEnoughKeys", message: "Not enough account keys given to the instruction" },
  ],
  [3006, { name: "AccountNotMutable", message: "The given account is not mutable" }],
  [
    3007,
    {
      name: "AccountOwnedByWrongProgram",
      message: "The given account is owned by a different program than expected",
    },
  ],
  [3008, { name: "InvalidProgramId", message: "Program ID was not as expected" }],
  [3009, { name: "InvalidProgramExecutable", message: "Program account is not executable" }],
  [3010, { name: "AccountNotSigner", message: "The given account did not sign" }],
  [
    3011,
    {
      name: "AccountNotSystemOwned",
      message: "The given account is not owned by the system program",
    },
  ],
  [
    3012,
    {
      name: "AccountNotInitialized",
      message: "The program expected this account to be already initialized",
    },
  ],
  [
    3013,
    { name: "AccountNotProgramData", message: "The given account is not a program data account" },
  ],
  [
    3014,
    {
      name: "AccountNotAssociatedTokenAccount",
      message: "The given account is not the associated token account",
    },
  ],
  [
    3015,
    {
      name: "AccountSysvarMismatch",
      message: "The given public key does not match the required sysvar",
    },
  ],
  [
    3016,
    {
      name: "AccountReallocExceedsLimit",
      message: "The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit",
    },
  ],
  [
    3017,
    {
      name: "AccountDuplicateReallocs",
      message: "The account was duplicated for more than one reallocation",
    },
  ],
  [
    4100,
    {
      name: "DeclaredProgramIdMismatch",
      message: "The declared program id does not match the actual program id",
    },
  ],
  [
    4101,
    {
      name: "TryingToInitPayerAsProgramAccount",
      message: "You cannot/should not initialize the payer account as a program account",
    },
  ],
  [
    4102,
    {
      name: "InvalidNumericConversion",
      message:
        "The program could not perform the numeric conversion, out of range integral type conversion attempted",
    },
  ],
  [
    5000,
    {
      name: "Deprecated",
      message: "The API being used is deprecated and should no longer be used",
    },
  ],
]);
