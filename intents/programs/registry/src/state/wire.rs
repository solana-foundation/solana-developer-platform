//! The field types of the registry's accounts. A program build uses the wire types of
//! `sdp_intents_spec`. Anchor describes only its own pod types and its derives in an IDL, so the IDL
//! build uses Anchor's pod types and a copy of `SemverV1` instead. Both sets have the same layout.

#[cfg(not(feature = "idl-build"))]
pub use sdp_intents_spec::wire::{PodBool, PodU16, PodU32, PodU64, SemverV1};

#[cfg(feature = "idl-build")]
pub use anchor_lang::pod::{PodBool, PodU16, PodU32, PodU64};

#[cfg(feature = "idl-build")]
#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable, anchor_lang::IdlType)]
pub struct SemverV1 {
    pub major: PodU16,
    pub minor: PodU16,
    pub patch: PodU16,
}

pub fn semver(major: u16, minor: u16, patch: u16) -> SemverV1 {
    SemverV1 { major: PodU16::from(major), minor: PodU16::from(minor), patch: PodU16::from(patch) }
}

/// The version that a document id names, as the registry's accounts store it.
pub fn stored_version(version: &sdp_intents_spec::wire::SemverV1) -> SemverV1 {
    semver(version.major.get(), version.minor.get(), version.patch.get())
}
