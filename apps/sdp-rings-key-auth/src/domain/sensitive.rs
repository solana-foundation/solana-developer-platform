//! Redacted, zeroizing JSON used for decrypted wallet projections.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use zeroize::Zeroize as _;

/// A serializable string that redacts logs and clears its allocation on drop.
pub struct SensitiveString(String);

impl fmt::Debug for SensitiveString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SensitiveString([redacted])")
    }
}

impl<'de> Deserialize<'de> for SensitiveString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl Serialize for SensitiveString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// JSON whose values may contain decrypted note blindings.
///
/// Serialization is implemented because the projection must be forwarded between
/// SDP and the sidecar. `Debug` is always redacted, cloning is intentionally
/// unavailable, and owned strings are cleared on drop.
pub struct SensitiveJson(Value);

impl SensitiveJson {
    /// Borrows the contained value at an explicit disclosure point.
    pub fn expose(&self) -> &Value {
        &self.0
    }
}

impl fmt::Debug for SensitiveJson {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SensitiveJson([redacted])")
    }
}

impl<'de> Deserialize<'de> for SensitiveJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Value::deserialize(deserializer).map(Self)
    }
}

impl Serialize for SensitiveJson {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl Drop for SensitiveJson {
    fn drop(&mut self) {
        zeroize_value(&mut self.0);
    }
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => {
            for value in values.iter_mut() {
                zeroize_value(value);
            }
            values.clear();
        }
        Value::Object(values) => {
            for (mut key, mut value) in std::mem::take(values) {
                key.zeroize();
                zeroize_value(&mut value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    *value = Value::Null;
}
