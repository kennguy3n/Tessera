import { useState, useCallback } from "react";

interface IpcState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useIpc<T>(ipcCall: (...args: unknown[]) => Promise<T>) {
  const [state, setState] = useState<IpcState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const execute = useCallback(
    async (...args: unknown[]) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const data = await ipcCall(...args);
        setState({ data, loading: false, error: null });
        return data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, loading: false, error: message }));
        throw err;
      }
    },
    [ipcCall],
  );

  return { ...state, execute };
}

function getTessera() {
  if (typeof window !== "undefined" && window.tessera) {
    return window.tessera;
  }
  return null;
}

export function getTesseraApi() {
  return getTessera();
}
