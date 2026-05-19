import { useState, useEffect, useCallback } from "react";
import type { SettingsData } from "../types/ipc";

const DEFAULT_SETTINGS: SettingsData = {
  theme: "light",
  defaultExportFormat: "markdown",
  ignorePatterns: [".git", "node_modules", ".DS_Store"],
  watchPatterns: ["**/*.md", "**/*.txt", "**/*.csv", "**/*.json"],
};

export function useSettings() {
  const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (api) {
        const data = await api.settings.get();
        setSettings(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { settings, loading, error, refresh };
}

export function useUpdateSetting() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(async (partial: Partial<SettingsData>) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.settings.update(partial);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { update, loading, error };
}
