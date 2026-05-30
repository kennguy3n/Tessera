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
//! - **macOS** — `getrusage(RUSAGE_SELF).ru_maxrss` reports bytes
//!   (the BSD convention, not Linux's kilobytes). The value is the
//!   peak, not the current, RSS, which is fine for our purposes:
//!   the test in `tests/memory_profile.rs` asserts on peak RSS.
//! - **Windows / other** — return `None`. The caller surfaces that
//!   as "RSS unavailable" rather than asserting.
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
        // SAFETY: `getrusage` writes into a zeroed-out struct we
        // own; the function is part of the POSIX standard and is
        // present on every macOS host.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        if rc != 0 {
            return None;
        }
        // `ru_maxrss` is in bytes on macOS, kilobytes on Linux.
        // We only ever hit this branch on macOS.
        Some(usage.ru_maxrss as u64)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = Path::new; // suppress unused-import warning
        None
    }
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
}
