//! Phase 15 Task 4 — process resident-set-size sampler.
//!
//! Exposes a single `current_rss_bytes()` accessor that returns the
//! current resident-set size of the calling process in bytes, or
//! `None` if the host platform doesn't expose that information
//! through a free interface.
//!
//! Implementations per platform:
//!
//! - **Linux** — read `/proc/self/status` and parse the `VmRSS:`
//!   line. The value is reported in kilobytes; we convert to
//!   bytes. Reading `/proc/self/status` is the canonical
//!   zero-dependency way to sample RSS on Linux — `getrusage(2)`
//!   `ru_maxrss` reports kilobytes (`man 2 getrusage` confirms the
//!   unit choice differs from macOS's bytes), and `/proc/self/stat`
//!   field 24 (`rss`) reports pages.
//! - **macOS** — shell out to `ps -o rss= -p <pid>`. The
//!   alternative `getrusage(RUSAGE_SELF).ru_maxrss` would be one
//!   syscall instead of a fork+exec, but it requires an `unsafe`
//!   FFI call, and this crate inherits the workspace-wide
//!   `unsafe_code = "forbid"` lint from `Cargo.toml:60`. `ps` is
//!   POSIX-mandated, present on every macOS host, and the
//!   resolution we need is "is this within an order of magnitude
//!   of the budget" — a 5-10 ms fork overhead is invisible here
//!   because the function is only called from the profiling-only
//!   `--profile` flag, never on the production hot path. The `ps`
//!   `rss=` (no header) column reports KB.
//! - **Windows / other** — return `None`. The caller surfaces that
//!   as "RSS unavailable" rather than asserting. We do not shell
//!   out to PowerShell's `Get-Process` here because it would
//!   require a working PowerShell runtime in every build target,
//!   which is not a reasonable assumption for a Rust crate; the
//!   `--profile` flag's JSONL log emits an explicit
//!   `rss_unavailable: true` so the user knows.
//!
//! The function is intentionally `pub` (not `pub(crate)`) so the
//! `--profile` flag added to the bridge in Task 4 can emit the
//! sample through the JSONL log. Production code in the indexer /
//! manager never calls this — it's strictly a profiling /
//! diagnostic accessor.

use std::path::Path;

/// Return the calling process's resident-set size in bytes, or
/// `None` when unavailable on this platform.
///
/// See module docs for per-platform implementation choices.
pub fn current_rss_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        read_proc_self_status_vmrss(Path::new("/proc/self/status"))
    }

    #[cfg(target_os = "macos")]
    {
        macos_rss_via_ps()
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// Sample the calling process's RSS on macOS by invoking
/// `ps -o rss= -p <pid>` and parsing the (KB) output.
///
/// Why `ps` instead of `getrusage`: the workspace forbids `unsafe`
/// (`Cargo.toml:60`) and `getrusage` requires an FFI call. The
/// `ps` invocation is one fork+exec (~5-10 ms on macOS), which is
/// invisible because this accessor is only called from the
/// profiling-only `--profile` flag, never on the production hot
/// path. See module docs for the full rationale.
///
/// Returns `None` if `ps` is not found, exits non-zero, or emits
/// output that doesn't parse as a positive integer. The
/// `--profile` flag treats `None` as "RSS unavailable".
#[cfg(target_os = "macos")]
fn macos_rss_via_ps() -> Option<u64> {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_rss_output(&out.stdout)
}

/// Parse the bytes of `ps -o rss= -p <pid>`'s stdout into RSS
/// bytes. Extracted so the macOS path is unit-testable without
/// invoking `ps`.
///
/// The `rss=` column (no header) is the only column on a single
/// line, in kilobytes per the POSIX `ps` spec. We trim whitespace
/// and parse as `u64`; on any non-numeric input we return `None`.
#[cfg(any(target_os = "macos", test))]
fn parse_ps_rss_output(stdout: &[u8]) -> Option<u64> {
    let s = std::str::from_utf8(stdout).ok()?;
    let kb: u64 = s.trim().parse().ok()?;
    Some(kb.saturating_mul(1024))
}

/// Parse a `/proc/self/status`-formatted file for the `VmRSS:`
/// line. Extracted so the Linux path is unit-testable against a
/// captured fixture without a live `/proc` mount.
///
/// Returns the RSS in bytes, or `None` if the file is unreadable
/// or doesn't contain a recognisable `VmRSS:` entry. The Linux
/// convention is that the second field is a count and the third
/// field is the unit (`kB` for `VmRSS`); we honour the `kB`
/// suffix and multiply accordingly.
pub fn read_proc_self_status_vmrss(path: &Path) -> Option<u64> {
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let mut parts = rest.split_whitespace();
            let value: u64 = parts.next()?.parse().ok()?;
            let unit = parts.next().unwrap_or("kB");
            let multiplier: u64 = match unit {
                "B" => 1,
                "kB" | "KB" => 1024,
                "mB" | "MB" => 1024 * 1024,
                _ => return None,
            };
            return Some(value.saturating_mul(multiplier));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_vmrss_kilobytes_to_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            "Name:\ttessera\nState:\tR (running)\nVmPeak:\t12345 kB\nVmRSS:\t  102400 kB\n"
        )
        .unwrap();
        let bytes = read_proc_self_status_vmrss(&path).unwrap();
        assert_eq!(bytes, 102_400 * 1024);
    }

    #[test]
    fn missing_vmrss_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status");
        std::fs::write(&path, "Name:\ttessera\nState:\tR (running)\n").unwrap();
        assert_eq!(read_proc_self_status_vmrss(&path), None);
    }

    #[test]
    fn missing_file_returns_none() {
        let path = Path::new("/proc/this/path/does/not/exist/at/all/abc123");
        assert_eq!(read_proc_self_status_vmrss(path), None);
    }

    #[test]
    fn rejects_unknown_unit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status");
        std::fs::write(&path, "VmRSS:\t100 weirdunit\n").unwrap();
        assert_eq!(read_proc_self_status_vmrss(&path), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn current_rss_bytes_is_some_on_linux() {
        let rss = current_rss_bytes();
        assert!(
            rss.is_some_and(|b| b > 0),
            "VmRSS for the running test process should be > 0 on Linux, got {rss:?}"
        );
    }

    #[test]
    fn parses_ps_rss_kilobytes_to_bytes() {
        // `ps -o rss=` emits the number with leading whitespace
        // and a trailing newline on macOS. Verify we strip both.
        let raw = b"  102400\n";
        assert_eq!(parse_ps_rss_output(raw), Some(102_400 * 1024));
    }

    #[test]
    fn rejects_non_numeric_ps_output() {
        assert_eq!(parse_ps_rss_output(b"not a number\n"), None);
        assert_eq!(parse_ps_rss_output(b""), None);
        assert_eq!(parse_ps_rss_output(b"   \n"), None);
    }

    #[test]
    fn rejects_negative_ps_rss() {
        // `ps -o rss=` can never emit a negative; defensively
        // verify the `u64::parse()` path rejects it cleanly so
        // a corrupted `ps` build can't poison the profiler with
        // a wraparound value.
        assert_eq!(parse_ps_rss_output(b"-1\n"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn current_rss_bytes_is_some_on_macos() {
        let rss = current_rss_bytes();
        assert!(
            rss.is_some_and(|b| b > 0),
            "ps -o rss= for the running test process should be > 0 on macOS, got {rss:?}"
        );
    }
}
