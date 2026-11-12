//! Ids, versions, and version ranges: `solana.org/token.transfer`, `1.0.0`, and `^1`.

use sha2::{Digest, Sha256};

use sdp_intents_spec::wire::{DocumentIdV1, PodU16, SemverV1};
use sdp_intents_spec::Address;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Id {
    pub organization: String,
    pub name: String,
}

impl Id {
    pub fn parse(text: &str) -> Result<Self, String> {
        let (organization, name) = text.split_once('/').ok_or_else(|| {
            format!("`{text}` is not an id. An id is `{{organization}}/{{name}}`, such as `solana.org/token.transfer`.")
        })?;

        [organization, name].iter().try_for_each(|part| {
            let valid =
                !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));

            if valid {
                Ok(())
            } else {
                Err(format!("`{part}` in `{text}` can hold only letters, digits, `.`, `-`, and `_`"))
            }
        })?;

        Ok(Self { organization: organization.to_owned(), name: name.to_owned() })
    }

    pub fn name_hash(&self) -> [u8; 32] {
        Sha256::digest(self.name.as_bytes()).into()
    }

    pub fn document_id(&self, publisher: Address, version: SemverV1) -> DocumentIdV1 {
        DocumentIdV1 { publisher, name_hash: self.name_hash(), version }
    }
}

impl std::fmt::Display for Id {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.organization, self.name)
    }
}

pub fn parse_version(text: &str) -> Result<SemverV1, String> {
    let parts: Vec<&str> = text.split('.').collect();
    let [major, minor, patch] = parts.as_slice() else {
        return Err(format!("`{text}` is not a version. A version is `major.minor.patch`, such as `1.0.0`."));
    };

    Ok(SemverV1 { major: number(major, text)?, minor: number(minor, text)?, patch: number(patch, text)? })
}

/// A caret range, `^1`, `^1.2`, or `^1.2.3`. Its lowest version is the one the binary form holds.
pub fn parse_range(text: &str) -> Result<SemverV1, String> {
    let caret = text
        .strip_prefix('^')
        .ok_or_else(|| format!("`{text}` is not a range. A range is a caret range, such as `^1`."))?;
    let parts: Vec<&str> = caret.split('.').collect();
    let zero = PodU16::new(0);

    match parts.as_slice() {
        [major] => Ok(SemverV1 { major: number(major, text)?, minor: zero, patch: zero }),
        [major, minor] => Ok(SemverV1 { major: number(major, text)?, minor: number(minor, text)?, patch: zero }),
        [major, minor, patch] => {
            Ok(SemverV1 { major: number(major, text)?, minor: number(minor, text)?, patch: number(patch, text)? })
        }
        _ => Err(format!("`{text}` is not a range. A range is a caret range, such as `^1`.")),
    }
}

/// An id with a caret range, such as `solana.org/token.transfer@^1`, or with an exact version, such
/// as `solana.org/token.transfer@1.0.0`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdRange {
    pub id: Id,
    pub lowest: SemverV1,
    pub exact: bool,
}

impl IdRange {
    pub fn parse(text: &str) -> Result<Self, String> {
        let (id, range) = text.split_once('@').ok_or_else(|| {
            format!("`{text}` names no range. Write the id and a range, such as `solana.org/token.transfer@^1`.")
        })?;
        let exact = !range.starts_with('^');
        let lowest = if exact { parse_version(range)? } else { parse_range(range)? };

        Ok(Self { id: Id::parse(id)?, lowest, exact })
    }

    pub fn covers(&self, version: SemverV1) -> bool {
        if self.exact {
            return version == self.lowest;
        }

        caret_covers(self.lowest, version)
    }
}

/// Whether `^lowest` accepts `version`: the same major version, and no lower.
pub fn caret_covers(lowest: SemverV1, version: SemverV1) -> bool {
    version.major == lowest.major
        && (version.minor.get(), version.patch.get()) >= (lowest.minor.get(), lowest.patch.get())
}

pub fn format_version(version: SemverV1) -> String {
    format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get())
}

fn number(part: &str, text: &str) -> Result<PodU16, String> {
    part.parse::<u16>().map(PodU16::new).map_err(|_| format!("`{part}` in `{text}` is not a number up to 65535"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ids_versions_and_ranges() {
        let id = Id::parse("solana.org/token.transfer").unwrap();

        assert_eq!(id.organization, "solana.org");
        assert_eq!(id.name, "token.transfer");
        assert_eq!(format_version(parse_version("1.2.3").unwrap()), "1.2.3");
        assert_eq!(format_version(parse_range("^1").unwrap()), "1.0.0");
        assert_eq!(format_version(parse_range("^1.4").unwrap()), "1.4.0");
    }

    #[test]
    fn explains_bad_forms() {
        assert!(Id::parse("token.transfer").unwrap_err().contains("{organization}/{name}"));
        assert!(parse_version("1.0").unwrap_err().contains("major.minor.patch"));
        assert!(parse_range("1.0.0").unwrap_err().contains("caret"));
    }
}
