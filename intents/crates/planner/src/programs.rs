//! The programs and sysvars that the planner names by address.

pub use sdp_intents_engine::ASSOCIATED_TOKEN_PROGRAM;
use sdp_intents_spec::Address;

/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
pub const TOKEN_PROGRAM: Address = Address([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
pub const TOKEN_2022_PROGRAM: Address = Address([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);
/// `SysvarC1ock11111111111111111111111111111111`.
pub(crate) const CLOCK_SYSVAR: Address = Address([
    6, 167, 213, 23, 24, 199, 116, 201, 40, 86, 99, 152, 105, 29, 94, 182, 139, 94, 184, 163, 155, 75, 109, 92, 115,
    85, 91, 33, 0, 0, 0, 0,
]);
/// The offset of `unix_timestamp` in the Clock sysvar's data, after the slot, the epoch start
/// timestamp, the epoch, and the leader schedule epoch.
pub(crate) const CLOCK_UNIX_TIMESTAMP: usize = 32;
