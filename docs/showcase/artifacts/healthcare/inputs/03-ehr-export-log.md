# EHR Export Audit Log Excerpt — Epic "Clarity" Reporting

Pulled by HIM Analyst on 2026-02-18. Filtered to user `dwhitfield`, last 30 days.

```
TIMESTAMP (CT)        USER         REPORT                       ROWS   FORMAT
2026-02-15 16:22:11   dwhitfield   Infusion Clinic Worklist     220    XLSX
2026-02-08 16:05:47   dwhitfield   Infusion Clinic Worklist     198    XLSX
2026-02-01 15:58:02   dwhitfield   Infusion Clinic Worklist     205    XLSX
```

## Field-level contents of "Infusion Clinic Worklist"

The standard worklist export includes the following columns:

- Patient legal name
- Medical Record Number (MRN)
- Date of birth
- Primary oncology diagnosis (ICD-10)
- Chemotherapy regimen + cycle/day
- Treating provider
- Insurance plan name + member ID

No Social Security Numbers are included in this report. No financial account
numbers. The 2026-02-15 export (220 rows) matches the file the reporter
described downloading for the Saturday clinic.
