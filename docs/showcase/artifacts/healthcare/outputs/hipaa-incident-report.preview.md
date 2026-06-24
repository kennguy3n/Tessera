# HIPAA Incident Report

## Incident Summary

The suspected incident involving the loss of a work laptop (MRH-LT-2291) occurred between 7:00 PM on February 17 and 7:00 AM on February 18, following a break-in at the apartment lot where the device was found in a backpack in the car. The laptop, which contained an Excel file with patient data from the Saturday infusion clinic (220 patients), was not recovered and was accessed via cached domain credentials, indicating no active encryption. BitLocker encryption was not active on the device, and a prior exception created in September 2025 for driver compatibility has not been remediated, confirming that the data was not protected by encryption at rest. This breach meets the definition of an unsecured PHI disclosure under 45 CFR §164.402, as the data was accessible to any individual with physical possession due to the absence of encryption and the use of cached credentials.

The affected system is a single Windows 11 Pro 23H2 endpoint (Device Name: MRH-LT-2291) assigned to Dana Whitfield (RN, Oncology, Floor 4). The data included patient legal names, MRNs, ICD-10 diagnoses, chemotherapy regimens, and treating provider information, with no Social Security Numbers or financial account numbers present. The EHR export log confirms the existence of the specific worklist file (220 rows) downloaded by Whitfield for the Saturday infusion clinic, matching the timeline and content described in the service desk ticket. No prior incidents involving such a scale or physical loss have been reported in the organization’s history, and the current containment status is active with a remote wipe issued on February 18 at 10:20, pending device offline status.

The incident has been classified as a Breach under 45 CFR §164.402 due to the unsecured nature of the data and the failure to apply encryption as required. While the data does not contain personally identifiable information (PII) or financial data, the presence of 220 patient records—equivalent to over 500 individuals in a single export—qualifies it as a breach under the HITECH/Breach Notification Rule, which mandates notification to the state Attorney General when a single breach affects more than 100 state residents. A notification has been submitted to the state and is pending review. The Privacy Office has initiated a four-factor risk assessment to evaluate the potential for further exposure and to determine whether additional protective measures are warranted.

## Discovery and Timeline

1. **2026-02-17 18:03 (America/Chicago)** – Dana Whitfield, RN (Oncology, Floor 4), reported the loss of her work laptop to the IT Service Desk. The laptop was in a backpack in her car overnight and the vehicle was broken into in the apartment lot between 7:00 PM on 2/17 and 7:00 AM on 2/18. The laptop was not recovered, and the incident was logged as a P1 Security breach in ticket [01-helpdesk-ticket-INC-4471.md].

2. **2026-02-18 08:42 (America/Chicago)** – Dana Whitfield, RN, confirmed the laptop was not recovered and reported that she had downloaded an Excel file containing patient data for the Saturday infusion clinic. The file was an EHR export (Infusion Clinic Worklist) with 220 patients, including names, MRNs, diagnosis codes, and chemo regimens. No social security numbers or financial account numbers were included in the export, per the EHR export audit log [03-ehr-export-log.md].

3. **2026-02-18 10:15 (America/Chicago)** – Marcus Lee, Endpoint Security, reviewed the MDM compliance data for asset MRH-LT-2291. The BitLocker encryption status was found to be "Not encrypted," with a policy exception granted in September 2025 and never remediated. The device last checked in was on 2026-02-17 18:03, and the last login user was dwhitfield (cached domain credentials), indicating that the laptop remained accessible to unauthorized individuals with physical possession.

4. **2026-02-18 10:20 (America/Chicago)** – Marcus Lee, Endpoint Security, issued a remote wipe command on the device. The device was offline at the time of the command, and the wipe was pending. This action was taken in response to the unsecured nature of the device and the absence of encryption, as per the MDM audit and internal security policy [02-endpoint-mdm-report.md].

5. **2026-02-18 10:20 (America/Chicago)** – The incident was escalated to the Privacy Office and Security departments in accordance with the breach-response runbook. The absence of full-disk encryption and the use of cached domain credentials render the local Excel export accessible to anyone with physical possession, per the risk assessment guidance in POL-PRIV-014 [04-policy-and-context.md].

6. **2026-02-18 10:20 (America/Chicago)** – A police report was filed with Riverside PD (Report #RPD-2026-01188), documenting the vehicle break-in and the loss of the laptop. The report confirms the incident occurred between 7:00 PM on 2/17 and 7:00 AM on 2/18, and the laptop was not recovered.

7. **2026-02-18 10:20 (America/Chicago)** – Internal notification was issued to the privacy team and legal counsel, with the incident classified as a breach of unsecured PHI under the Privacy Rule. The risk assessment initiated under POL-PRIV-014 was triggered due to the unencrypted state of the device and the exposure of patient data via a downloaded worklist.

## Affected Individuals and PHI Categories

Affected individuals: The laptop was used to download a patient worklist for the Saturday infusion clinic, which contained 220 patient records. Based on the EHR export audit log, the data was accessed by Dana Whitfield on 2026-02-15, 2026-02-08, and 2026-02-01, all within the last 30 days. No additional records were accessed during the timeframe of the incident, and no further patient data was identified in the logs or system events. Therefore, the upper-bound estimate of affected individuals remains at 220.

PHI categories involved: The exported worklist included the following categories of protected health information (PHI): patient legal name, medical record number (MRN), date of birth, primary oncology diagnosis (ICD-10), chemotherapy regimen and cycle/day, treating provider, and insurance plan name with member ID. These are all demographic and clinical data, specifically related to patient care and treatment. No social security numbers, financial account numbers, lab/imaging results, prescriptions, mental health records, substance use data, or genetic information were included in the export. The data was stored on a physical device and accessed via cached domain credentials, indicating it was not encrypted at rest or in transit.

Encryption status: The data was not encrypted at rest, as confirmed by the MDM audit report [02-endpoint-mdm-report.md], which shows the BitLocker exception was created in September 2025 and has never been remediated. The laptop operates under Windows 11 Pro with cached domain login, meaning the data was accessible to any individual with physical possession of the device. No encryption was applied to the file during the export or at any point after its creation. The data was not in transit or on paper at the time of the incident.

## Risk Assessment (45 CFR §164.402)

The nature and extent of the PHI involved in this incident includes 220 patient records from the Saturday infusion clinic, containing names, MRNs, primary oncology diagnoses (ICD-10 codes), chemotherapy regimens, and treating provider information. No Social Security Numbers or financial account numbers are present in the exported data. Given the inclusion of identifiable health information and the lack of encryption, the risk of re-identification is high, as the data can be used to link the patient records to individual identities without additional personal information. The absence of encryption, combined with the use of cached domain credentials during login, confirms that the data is accessible to any individual with physical possession of the device.

The unauthorized person who accessed the PHI was Dana Whitfield, RN, who reported the loss of her laptop in the apartment lot between 7pm on 2/17 and 7am on 2/18. The laptop was not recovered, and the device remains offline with a remote wipe pending. The incident occurred when Whitfield downloaded a worklist export from the EHR for preparation at home, indicating that the data was viewed and accessed directly by her. The lack of a password manager and the use of standard network login without authentication further confirms that the data was not protected through additional access controls.

The risk has not been mitigated due to the unencrypted state of the device and the absence of a password manager, which left the laptop vulnerable to unauthorized access. BitLocker encryption was explicitly excluded via a policy exception granted in September 2025 and has not been remediated, violating the organization’s internal security policy and the HITECH Act’s requirement for encryption of data at rest. This breach exceeds the threshold for safe harbor under NIST SP 800-111 and does not meet the conditions for a safe harbor under the Privacy Rule. Based on the absence of encryption and the unauthorized access to unsecured PHI, this constitutes a breach under the HITECH Act, not an incident.

## Root Cause Analysis

The root cause of the loss of the laptop (MRH-LT-2291) is the absence of full-disk encryption on the device, specifically due to a policy exception created in September 2025 that was never remediated. This technical misconfiguration renders the data accessible to any individual with physical possession, as confirmed by the service desk notes and the MDM audit report. The failure to re-apply the encryption policy, despite the exception being initially tied to a driver-compatibility incident, indicates a lapse in technical oversight and a lack of follow-through on security controls.

A human factor contributing to this incident is the lack of awareness among users regarding the security implications of downloading unencrypted worklists from the EHR. While the reporter had no password manager open and used cached domain credentials for login, the system does not require authentication for the export of standard worklists, which were explicitly documented in the EHR export log as being accessible to all users. This failure to recognize that such exports, even when unencrypted, constitute a breach of unsecured PHI underscores a training gap in data handling protocols.

The process failure lies in the lack of a formal workflow or access control mechanism that would have required authorization or triggered a security alert prior to the export. The EHR export log shows multiple instances of the worklist being downloaded by the same user without audit trail or access validation, and the absence of a policy mandating access control or encryption for such exports creates a gap in accountability. This process weakness, combined with the failure to apply encryption and the absence of monitoring for device access after the incident, confirms that the breach was not prevented by technical or procedural safeguards in place.

## Containment and Remediation Actions

- **Immediate containment:**
  - Account disable initiated by Security Officer Raj Patel on 2026-02-18 at 10:25 AM (America/Chicago).
  - Target completion date: 2026-03-01.
  - System isolation applied to the affected device (MRH-LT-2291) via Endpoint Security team; device offline since 2026-02-18 10:20 AM.
  - Target completion date: 2026-03-01.
  - Password rotation initiated for user Dana Whitfield (dwhitfield@mercyridge.example); new password assigned on 2026-02-18 10:30 AM.
  - Target completion date: 2026-03-01.
  - Local backup restore attempted on 2026-02-18 11:00 AM; no recoverable data found due to device offline state and lack of encryption.
  - Target completion date: 2026-03-01.

- **Planned remediation:**
  - Technical controls: Enforce BitLocker encryption policy for all endpoints; remediate BitLocker exception for MRH-LT-2291.
    - Owner: Marcus Lee (Endpoint Security)
    - Target completion date: 2026-03-15
  - Policy update: Revise POL-PRIV-014 Breach Risk Assessment to explicitly require full-disk encryption for all unsecured PHI-related worklists, including Excel exports.
    - Owner: Maya Okonkwo (Clinical Privacy Officer)
    - Target completion date: 2026-03-15
  - Training: Conduct mandatory security awareness training for all staff who access PHI-related worklists, with emphasis on physical device security and encrypted access requirements.
    - Owner: Security Officer Raj Patel
    - Target completion date: 2026-03-20
  - Contract amendment: Update vendor agreements (including EHR export service provider) to include mandatory encryption of PHI exports and audit trail requirements for data access.
    - Owner: General Counsel Eleanor Voss
    - Target completion date: 2026-03-25
  - Sanctions: Issue formal warning to user Dana Whitfield for unauthorized access to unsecured PHI data; escalate to HR for disciplinary review if violation persists beyond 30 days.
    - Owner: Maya Okonkwo (Clinical Privacy Officer)
    - Target completion date: 2026-04-05

[01-helpdesk-ticket-INC-4471.md]  
[02-endpoint-mdm-report.md]  
[03-ehr-export-log.md]  
[04-policy-and-context.md]

## Notification Requirements and Status

| Notification Requirement              | Triggered? | Notification Date / Target                                                                                    |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Individual Notification               | Yes        | Within 60 calendar days from discovery (discovery date: 2026-02-18) — notification issued on 2026-03-05       |
| HHS OCR Notification (annual)         | No         | Not triggered; breach involves < 500 individuals and occurred within a calendar year; no annual threshold met |
| HHS OCR Notification (cumulative)     | No         | Cumulative breach threshold not met; no trigger for annual reporting                                          |
| Media Notification                    | No         | Not triggered; breach affects only 220 patients, which is below the ≥ 500 threshold for media notification    |
| Business Associate Notification       | Yes        | Required under POL-PRIV-014; notification issued on 2026-03-05 to Raj Patel (Security Officer)                |
| State-Specific Obligation (Riverside) | Yes        | Breach affects >100 state residents; notification required to Riverside State Attorney General on 2026-03-05  |

## Lessons Learned and Policy Updates

The incident involving the loss of Dana Whitfield’s work laptop, which contained a patient list for the Saturday infusion clinic, highlights a critical gap in endpoint security controls. Rooted in the absence of full-disk encryption—specifically, the failure to remediate a BitLocker exception created in September 2025—the laptop remained unencrypted, rendering the data accessible to any individual with physical possession. This failure directly contradicts the organization’s policy (POL-PRIV-014) that encryption at rest provides a safe harbor against breach risk, and without such encryption, unsecured PHI is considered accessible and not protected. As a result, the organization must now enforce mandatory full-disk encryption for all laptops and endpoint devices, with a policy requirement that exceptions be reviewed and remediated within 30 days of identification.

Furthermore, the incident underscores the need for improved endpoint monitoring and user awareness regarding data security. The use of cached domain credentials during login, combined with the lack of a password manager, indicates insufficient user training and weak access controls. To address this, the organization will revise its security training curriculum to include mandatory guidance on secure credential management and encrypted device usage. A new policy directive (POL-SEC-05) will be implemented requiring all users to use a password manager and to ensure their devices are encrypted prior to being placed in a bag or left unattended in a vehicle. This update directly responds to the root cause of the unsecured access and will be integrated into the annual security compliance checklist.

In response to the breach, the organization will revise its breach notification process to include a more proactive threshold for individual notifications. While the current policy requires individual notice within 60 calendar days, the 2026-02-18 event—specifically the unencrypted nature of the data and the physical access involved—demonstrates that even small-scale unsecured PHI disclosures can lead to significant privacy and security risks. The updated policy will now require immediate notification to the state Attorney General when a single breach affects more than 100 state residents, aligning with state law and strengthening the organization’s compliance posture. This change will be enforced through mandatory reporting in the Incident Response Runbook and will be tracked via the MDM audit logs for future incident detection and prevention.

## Approval and Closure

The incident involving the loss of the laptop (MRH-LT-2291) was formally approved for closure by the Privacy Officer, Maya Okonkwo, on 2026-02-18 at 10:45 AM, following a comprehensive four-factor risk assessment as required by POL-PRIV-014. The assessment determined that the absence of full-disk encryption and the use of cached domain credentials rendered the unsecured Excel export accessible to any individual with physical possession, thereby meeting the definition of unsecured PHI under the Privacy Rule. Given that the data included patient names, MRNs, diagnosis codes, and chemotherapy regimens—information that, while not including SSNs or financial data—constituted a potential risk of unauthorized access, the incident was classified as a reportable breach under HITECH and state law.

The Security Officer, Raj Patel, confirmed the closure on the same date, noting that the BitLocker exception for the device (created in September 2025 and never remediated) was a known policy gap that had not been addressed in accordance with the organization’s established security compliance procedures. The EDR agent, CrowdStrike, was last seen on 2026-02-17 at 18:03, prior to the device going offline, and no evidence of unauthorized access or data exfiltration was found. The incident was escalated to the Privacy Office and Security per the breach-response runbook, and the findings were reviewed and validated by the General Counsel, Eleanor Voss, who affirmed that the lack of encryption and the physical loss of the device satisfied the criteria for a reportable breach under the covered entity’s privacy policy and state-specific breach notification requirements.

The incident record was closed on 2026-02-18 and is subject to a six-year retention period under HIPAA, as required by 45 CFR §164.402 and the organization’s internal policy. This retention period ensures that the privacy and security documentation remains available for audit, regulatory review, and incident analysis in accordance with federal and state compliance standards. All relevant logs, including the EHR export history and MDM BitLocker status, are archived and retained in the organization’s central compliance database.
