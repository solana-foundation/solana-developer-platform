//! Stamps the pinned zolana revision into the binary.
//!
//! `/health` reports it so that skew between this build and the chain is visible
//! in monitoring. Read from `Cargo.toml` rather than duplicated, so the manifest
//! stays the single place the revision is declared.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    println!("cargo:rerun-if-changed={}", manifest.display());

    let rev = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|contents| extract_rev(&contents))
        .unwrap_or_else(|| "unknown".to_owned());

    println!("cargo:rustc-env=ZOLANA_REV={rev}");
}

/// Pulls the first `rev = "..."` out of the manifest.
///
/// Every zolana dependency is pinned to the same revision, since mixing them
/// would link two versions of the same protocol types, so the first occurrence is
/// the answer.
fn extract_rev(manifest: &str) -> Option<String> {
    manifest
        .lines()
        .filter(|line| line.contains("helius-labs/zolana"))
        .find_map(|line| {
            let after = line.split("rev = \"").nth(1)?;
            let rev = after.split('"').next()?;
            (!rev.is_empty()).then(|| rev.to_owned())
        })
}
