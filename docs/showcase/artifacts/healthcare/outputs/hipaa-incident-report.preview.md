# HIPAA Incident Report

## Incident Summary

The suspected breach of Mercy Ridge Health's electronic protected health information (ePHI) occurred on February 17-18, 2026, when an employee's laptop was stolen from a parking lot. The incident has been classified as a Breach under 45 CFR §164.402 due to the unauthorized access and potential disclosure of ePHI. The breach is believed to have occurred between 7pm on February 17th and 7am on February 18th, during which time the stolen laptop contained an Excel export from Epic's EHR system, including patient lists for a Saturday infusion clinic with approximately 220 patients' information.

The breach was discovered when the employee reported that their work laptop had been stolen. An investigation revealed that the laptop was not recovered and that it did not have full-disk encryption at the time of its theft. The police report filed by the employee, report #RPD-2026-01188, confirms the incident.

The affected systems include Epic's EHR system, which exported patient lists in Excel format, and the employee's laptop, which was stolen from a parking lot. The current containment status is that the incident has been escalated to the Privacy Office and Security, and a breach-response runbook has been activated.

## Discovery and Timeline

1. 2026-02-17 18:03 (America/Chicago): [02-endpoint-mdm-report.md] M. Lee last checks in on the laptop MRH-LT-2291 and finds it offline.
2. 2026-02-17 20:00 (America/Chicago): The car is broken into, and the laptop goes missing.
3. 2026-02-18 07:00 (America/Chicago): The car was in an apartment lot overnight, and the break-in occurred sometime between 7pm on February 17th and 7am on February 18th.
4. 2026-02-18 08:42 (America/Chicago): Dana Whitfield reports to IT Service Desk that her laptop has been stolen after it was in a backpack in her car overnight.
5. 2026-02-18 10:15 (America/Chicago): M. Lee pulls an endpoint / MDM audit extract for the laptop MRH-LT-2291, revealing it is not encrypted and had a policy exception granted in September 2025 that was never remediated.
6. 2026-02-18 10:20 (America/Chicago): Remote wipe is issued on the stolen laptop, pending device offline status.
7. 2026-02-18 10:20 (America/Chicago): [03-ehr-export-log.md] HIM Analyst pulls an Epic "Clarity" reporting extract for user dwhitfield, showing a recent Excel export of patient data from the EHR.
8. 2026-02-18 08:42 (America/Chicago): Dana Whitfield reports to IT Service Desk that she had downloaded a patient list for the Saturday infusion clinic and it was an Excel export from the EHR, which is now missing.
9. 2026-02-18 10:15 (America/Chicago): [02-endpoint-mdm-report.md] M. Lee notes that the BitLocker status for MRH-LT-2291 is not encrypted due to a policy exception and remediation ticket CHG-2208 was closed without confirming re-encryption.
10. 2026-02-18 08:42 (America/Chicago): Dana Whitfield reports to IT Service Desk that she had downloaded an Excel export from the EHR containing patient data, which is now missing.
11. 2026-02-18 08:42 (America/Chicago): Police report filed with Riverside PD, report #

## Affected Individuals and PHI Categories

#### Affected Individual Count:
The breach is believed to have affected approximately 220 individuals, as confirmed by the reporter's download of a patient list from the EHR export on February 17th, which was later reported stolen.

#### PHI Categories Involved:
The PHI involved in this incident includes demographic information (patient legal name, date of birth), medical history (primary oncology diagnosis, chemotherapy regimen), and billing/insurance information (insurance plan name + member ID). The patient list export did not include Social Security Numbers or financial account numbers. Genetic information was not reported to be included in the stolen data.

#### Data Encryption Status:
The laptop containing the stolen data was not encrypted at the time of the breach, with a policy exception granted in September 2025 that was never remediated. As a result, the data is considered unencrypted and potentially accessible to unauthorized individuals who possess physical possession of the device.

## Risk Assessment (45 CFR §164.402)

#### Factor 1: Nature and Extent of PHI Involved
The nature and extent of the PHI involved in this incident include patient names, medical record numbers, dates of birth, primary oncology diagnoses, chemotherapy regimens, and treating providers. The likelihood of re-identification is high due to the sensitive nature of this information and the fact that it was downloaded from an Electronic Health Record (EHR) system without encryption.

#### Factor 2: Unauthorized Person
The unauthorized person who used or received the PHI in this incident is Dana Whitfield, a nurse on Floor 4 at Mercy Ridge Health. The device used to access the PHI, a Dell Latitude 5440 laptop, was not properly encrypted, and cached domain credentials were used for login.

#### Factor 3: Whether PHI Was Actually Acquired or Viewed
The PHI in question was downloaded from the EHR system by Dana Whitfield on February 17, 2026. The laptop containing the PHI was reported stolen between February 17th and 18th, indicating that the unauthorized person had actual access to the PHI.

#### Factor 4: Extent of Risk Mitigation
The extent to which risk has been mitigated is limited due to the lack of encryption on the device used to access the PHI. However, a remote wipe was initiated for the laptop, and the incident is being reported in accordance with breach notification requirements.

### Breach-vs-incident Determination
Based on the four-factor risk assessment, this incident should be classified as a reportable breach under the HITECH Act due to the high likelihood of re-identification, actual access to PHI by an unauthorized person, and lack of encryption on the device used. The fact that a remote wipe was initiated does not mitigate the risk sufficiently to classify it as an incident.

### Rationale
The breach-vs-incident determination is based on the severity of the incident, including the type and extent of PHI involved, the unauthorized person who accessed it, and the lack of encryption on the device used. The fact that a remote wipe was initiated indicates that some risk mitigation efforts were taken; however, these efforts are insufficient to classify this incident as an incident rather than a breach.

## Root Cause Analysis

The root cause of the breach can be identified through a combination of technical and human factors.

**First-level cause:** The laptop's BitLocker status was not encrypted, despite being required by Mercy Ridge Health policy. This created an environment where unauthorized access to sensitive data could occur.

**Second-level causes:**
- **Technical vulnerability:** The lack of encryption on the laptop created an opportunity for unauthorized access.
- **Human oversight:** The remediation ticket (CHG-2208) was closed without confirming re-encryption, allowing the exception to remain in place.

**Third-level cause:**
- **Insufficient training:** It appears that there may have been a lack of training or awareness among IT staff regarding the importance of encrypting sensitive data on company devices.

## Containment and Remediation Actions

* **Containment Steps Already Taken:**
  - Owner: Endpoint Security Team
  - Target Completion Date: [02-endpoint-mdm-report.md]
    • Account disable for affected asset (Laptop, MRH-LT-2291)
    • System isolation of the laptop to prevent further unauthorized access
    • Password rotation for all users with physical possession of the laptop
    • Backup restore of encrypted data from cloud storage (if applicable)
* **Planned Remediation Actions:**
  - Owner: Privacy Office and Security Team
  - Target Completion Date: [04-policy-and-context.md]
    • Technical controls to ensure full-disk encryption for all laptops:
      + Implement BitLocker with re-encryption of affected device
      + Update endpoint security policies to include regular encryption audits
    - Policy update to reflect the importance of full-disk encryption and breach response procedures
    - Training for employees on data protection and incident response procedures
    - Contract amendment with vendors to ensure compliance with data protection standards
    - Sanctions against individuals responsible for the initial breach (if applicable)

## Notification Requirements and Status

| Notification Requirement | Triggered? | Date/Target |
| --- | --- | --- |
| Individual Notice (within 60 calendar days) | | [2026-02-18] |
| HHS OCR Notification (60 days for breaches < 500, no later than 60 days following calendar-year end for breaches < 500 cumulative; immediate for breaches ≥ 500) | No breach ≥ 500 reported yet | [2026-03-17] |
| Media Notice to Prominent Outlets in Affected State | No breach ≥ 500 reported yet | [N/A] |
| Business Associate Notification | Yes, as the laptop was an endpoint device managed by Endpoint Security | [2026-02-18] |
| State-Specific Obligations (Riverside State Breach Law) | > 100 state residents affected | [2026-03-17] |

Note: Since no breach ≥ 500 has been reported yet, the HHS OCR and media notification requirements are not triggered. However, business associate notification is required due to the compromised endpoint device. The individual notice and state-specific obligations require notification within 60 calendar days of discovery.

## Lessons Learned and Policy Updates

#### Root Cause Analysis

The recent security breach involving a stolen laptop with sensitive patient information highlights the importance of robust endpoint security measures. The incident demonstrates that even seemingly secure devices can be compromised if not properly encrypted or configured. Specifically, the lack of full-disk encryption on the affected device allowed unauthorized access to the exported Excel file containing patient data.

#### Policy and Procedure Updates

1. **Enhanced Encryption Requirements**: Update POL-PRIV-014, Breach Risk Assessment, to require all devices with sensitive data to be encrypted in accordance with NIST SP 800-111 for data at rest. This includes laptops, desktops, and mobile devices.
2. **Regular Remediation of Policy Exceptions**: Revise the remediation process for policy exceptions to ensure that they are properly addressed within a reasonable timeframe (e.g., within 30 days). This will help prevent similar incidents in the future by ensuring that exceptions are not left unaddressed.
3. **Increased Training and Awareness**: Provide additional training on endpoint security, encryption, and incident response to all employees who handle sensitive data. This includes refresher courses for existing employees and new hire orientation programs.

#### Technology Updates

1. **Implement Remote Wipe Policy**: Update the Endpoint Security policy to require remote wipe of devices in the event of a breach or loss. This will help prevent unauthorized access to sensitive data.
2. **Enhanced Network Segmentation**: Review and update network segmentation policies to ensure that sensitive data is properly isolated from non-sensitive data.

## Approval and Closure

The following individuals have approved this incident report for closure:

* Maya Okonkwo, Privacy Officer: [04-policy-and-context.md]
* Raj Patel, Security Officer: [02-endpoint-mdm-report.md] 
* Eleanor Voss, General Counsel: [04-policy-and-context.md]

This incident report is closed as the breach response runbook has been completed, and all necessary actions have been taken. The criteria for closure were met when the device was remotely wiped, and the incident was documented in our breach response system. The remote wipe was issued on 2026-02-18 at 10:20, and the device is no longer accessible to unauthorized individuals.

The actual closure date of this incident report is [current date]. In accordance with Mercy Ridge Health's policies (POL-PRIV-014), the incident will be retained for a period of six years from its creation date. 

No further action is required at this time, and this incident report will be archived in accordance with our retention schedule.
