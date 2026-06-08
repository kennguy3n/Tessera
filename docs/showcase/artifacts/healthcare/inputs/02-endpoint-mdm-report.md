# Endpoint / MDM Audit Extract — Asset MRH-LT-2291

Source: Intune compliance export, pulled 2026-02-18 10:15 by M. Lee

| Attribute | Value |
|---|---|
| Device name | MRH-LT-2291 |
| Assigned user | dwhitfield@mercyridge.example |
| OS | Windows 11 Pro 23H2 |
| **BitLocker status** | **Not encrypted** — policy exception granted 2025-09, never remediated |
| Last check-in | 2026-02-17 18:03 (America/Chicago) |
| Last login user | dwhitfield (cached domain creds) |
| Remote wipe issued | 2026-02-18 10:20 — **device offline, wipe pending** |
| Local admin | No |
| EDR agent | CrowdStrike, last seen 2026-02-17 18:03 |

## Analyst note (M. Lee)

The BitLocker exception was created during a driver-compatibility incident in
September 2025 and was supposed to be temporary. The remediation ticket
(CHG-2208) was closed without confirming re-encryption. Because the disk is
unencrypted and the OS login uses cached domain credentials, the local Excel
export must be treated as accessible to anyone with physical possession.
