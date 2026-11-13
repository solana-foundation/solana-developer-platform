//! Writes the IDL of each Anchor program of this workspace to `target/idl/<program>.json`.
//! `deploy-surfnet.mjs` places each IDL beside its program, so that Solana Explorer decodes its
//! instructions on a local surfnet.
//!
//! An Anchor program is a member with a `cdylib` target and an `idl-build` feature. Only the lib
//! builds with `idl-build`, because the integration tests use the wire types that the IDL build
//! replaces. The IDL build has its own target directory, because it sets `RUSTFLAGS`.

use std::fs;
use std::path::{Path, PathBuf};

use anchor_lang_idl::build::IdlBuilder;
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().context("the crate has no parent directory")?;
    let output = workspace.join("target/idl");
    let target_dir = workspace.join("target/idl-build");
    fs::create_dir_all(&output)?;

    for program in anchor_programs(workspace)? {
        let idl = IdlBuilder::new()
            .program_path(program.clone())
            .cargo_args(vec!["--lib".into(), "--target-dir".into(), target_dir.display().to_string()])
            .build()
            .with_context(|| format!("the IDL of {} does not build", program.display()))?;

        let path = output.join(format!("{}.json", idl.metadata.name));
        fs::write(&path, serde_json::to_string_pretty(&idl)?)?;
        println!("wrote {}", path.display());
    }

    Ok(())
}

fn anchor_programs(workspace: &Path) -> Result<Vec<PathBuf>> {
    let entries = fs::read_dir(workspace)?.collect::<std::io::Result<Vec<_>>>()?;
    let mut programs: Vec<PathBuf> = entries
        .into_iter()
        .map(|entry| entry.path())
        .filter(|directory| {
            fs::read_to_string(directory.join("Cargo.toml")).is_ok_and(|manifest| is_anchor_program(&manifest))
        })
        .collect();

    programs.sort();
    Ok(programs)
}

fn is_anchor_program(manifest: &str) -> bool {
    manifest.contains("cdylib") && manifest.contains("\nidl-build = ")
}
