//! Tiny URL-encoding helper shared by all OAuth connectors.
//!
//! We deliberately do not pull the full `url` crate into every connector's
//! call-sites — the only thing we need is percent-encoding for OAuth
//! query parameters (`client_id`, `redirect_uri`, `scope`, …). The `url`
//! crate is still in the workspace and used elsewhere; this just keeps
//! the per-connector URL-building code self-contained and consistent
//! across providers (gdrive used to ship its own copy of this).

use std::fmt::Write;

/// Percent-encode a string for use in an OAuth query parameter.
///
/// Follows RFC 3986 unreserved characters (`A-Z a-z 0-9 - _ . ~`) verbatim
/// and percent-encodes everything else as uppercase `%HH`.
pub fn encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                let _ = write!(out, "{byte:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreserved_passthrough() {
        assert_eq!(encode("abcXYZ-09._~"), "abcXYZ-09._~");
    }

    #[test]
    fn space_and_special() {
        assert_eq!(encode("hello world"), "hello%20world");
        assert_eq!(encode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
    }

    #[test]
    fn multibyte() {
        // É (U+00C9) is C3 89 in UTF-8.
        assert_eq!(encode("É"), "%C3%89");
    }
}
