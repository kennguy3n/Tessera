export interface Settings {
  theme: "light" | "dark" | "system";
  defaultExportFormat: "markdown" | "html" | "csv" | "json";
  ignorePatterns: string[];
  watchPatterns: string[];
}
