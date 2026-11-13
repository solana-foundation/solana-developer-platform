use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("A name holds 1 to 64 letters, digits, '.', '-', and '_'")]
    BadName,
    #[msg("The name hash is not the SHA-256 of the name")]
    WrongNameHash,
    #[msg("The signer is not the authority that the instruction needs")]
    WrongAuthority,
    #[msg("An account is not the registry account that the instruction needs")]
    WrongAccount,
    #[msg("The index is of another kind")]
    WrongIndexKind,
    #[msg("The buffer is written by another key, or its length differs")]
    WrongBuffer,
    #[msg("The bytes reach past the end of the buffer")]
    OutOfBuffer,
    #[msg("The document is larger than 10,000 bytes")]
    DocumentTooLarge,
    #[msg("The buffer does not hash to the hash in the instruction")]
    WrongDocumentHash,
    #[msg("The document does not parse, or breaks a limit")]
    BadDocument,
    #[msg("The document's id does not match the index")]
    WrongDocumentId,
    #[msg("The interface index does not list the interface version that the implementation names")]
    InterfaceVersionNotPublished,
    #[msg("The version is published already")]
    AlreadyPublished,
    #[msg("The index does not list the version")]
    VersionNotPublished,
    #[msg("The head version cannot be removed. Move the head first.")]
    RemovesHead,
    #[msg("The interface approves the implementation already")]
    AlreadyApproved,
    #[msg("The implementation or the version is not approved")]
    NotApproved,
    #[msg("verify_intent runs only as a top-level instruction")]
    NotTopLevel,
    #[msg("An instruction before verify_intent is not a ComputeBudget instruction")]
    UnverifiedInstruction,
    #[msg("The intent turns off verifyIntent")]
    VerificationOff,
    #[msg("The intent asks for assertions, which verify_intent cannot check yet")]
    AssertionsUnavailable,
    #[msg("The record refuses the intent")]
    RecipeRefused,
    #[msg("An account differs from the one that the record derives at its place")]
    WrongRecipeAccount,
    #[msg("The number of instructions differs from what the record builds")]
    WrongInstructionCount,
    #[msg("An instruction differs from what the record builds")]
    WrongInstruction,
    #[msg("The builder returned no HashedReadyV1")]
    BadBuilderResult,
    #[msg("The instructions do not hash to the builder's hash")]
    WrongInstructionsHash,
    #[msg("A builder signer does not sign a built instruction")]
    UnsignedBuilderSigner,
    #[msg("The builder roles do not name one role for each account of the built instructions")]
    WrongBuilderRoles,
    #[msg("An account's role is not the union of its roles in the built instructions and the fee payer slot")]
    WrongRole,
    #[msg("The version was removed. A removed version cannot be published, approved, or made the head again.")]
    VersionRemoved,
}
