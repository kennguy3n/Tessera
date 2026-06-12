/**
 * Wire the App-level side effects for command-registry entries that
 * can't be expressed as a plain navigate (they call the
 * `window.tessera.*` bridge and need toast feedback):
 *
 *   - `tessera:create-artifact` (detail `{ type }`) — create a blank
 *     artifact of the given kind and open its editor. Fired by the
 *     palette's "New document / slide deck / …" commands.
 *   - `tessera:run-decay-sweep` — run the substrate decay sweep.
 *   - `tessera:trigger-synthesis` — run substrate synthesis.
 *   - `tessera:print` — open the system print dialog for the current
 *     view (the native Cmd/Ctrl+P print, rebound here to Cmd/Ctrl+Alt+P
 *     since Cmd/Ctrl+P now opens the command palette).
 *
 * Centralised here (not inline in `App`) so the wiring is unit-
 * testable and `App` stays a thin shell. Mounted once at the app
 * root. Every bridge call is wrapped so a rejected IPC surfaces a
 * privacy-safe toast instead of an unhandled rejection.
 *
 * The listeners are registered once for the app's lifetime: react-
 * router's `navigate` changes identity on every navigation, so we
 * read it (and `addToast`) through refs kept current by a commit-
 * phase effect rather than re-binding all three listeners each time
 * the route changes.
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../components/toastContext";
import { notifyArtifactsChanged } from "./useArtifacts";
import { ARTIFACT_TYPES } from "../constants/artifactTypes";

export function useGlobalCommandActions(): void {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const navigateRef = useRef(navigate);
  const addToastRef = useRef(addToast);
  useEffect(() => {
    navigateRef.current = navigate;
    addToastRef.current = addToast;
  });

  useEffect(() => {
    const bridge = () =>
      typeof window !== "undefined" ? window.tessera : undefined;

    const onCreateArtifact = (e: Event) => {
      const detail =
        e instanceof CustomEvent && e.detail && typeof e.detail === "object"
          ? (e.detail as { type?: string })
          : undefined;
      const spec = ARTIFACT_TYPES.find((s) => s.id === detail?.type);
      if (!spec) return;
      const api = bridge();
      if (!api) {
        addToastRef.current(
          "Can’t create — the desktop bridge is unavailable.",
          "error",
        );
        return;
      }
      void (async () => {
        try {
          const artifact = await api.artifacts.create(
            spec.defaultTitle,
            spec.id,
          );
          notifyArtifactsChanged();
          navigateRef.current(`/artifacts/${artifact.id}/edit`);
        } catch {
          addToastRef.current(
            `Couldn’t create the ${spec.label.toLowerCase()}. Please try again.`,
            "error",
          );
        }
      })();
    };

    const onRunDecaySweep = () => {
      const api = bridge();
      if (!api) {
        addToastRef.current("Memory tools need the desktop bridge.", "error");
        return;
      }
      void (async () => {
        try {
          const report = await api.substrate.runDecaySweep();
          const archived =
            report.candidatesArchived + report.supersededArchived;
          addToastRef.current(
            `Decay sweep done — ${report.scored} scored, ${archived} archived.`,
            "success",
          );
        } catch {
          addToastRef.current("Decay sweep failed. Please try again.", "error");
        }
      })();
    };

    const onTriggerSynthesis = () => {
      const api = bridge();
      if (!api) {
        addToastRef.current("Memory tools need the desktop bridge.", "error");
        return;
      }
      void (async () => {
        try {
          const summary = await api.substrate.triggerSynthesis();
          addToastRef.current(
            summary.recap
              ? `Synthesis complete: ${summary.recap}`
              : `Synthesis complete (v${summary.version}).`,
            "success",
          );
        } catch {
          addToastRef.current("Synthesis failed. Please try again.", "error");
        }
      })();
    };

    const onPrint = () => {
      if (typeof window !== "undefined" && typeof window.print === "function") {
        window.print();
      }
    };

    window.addEventListener("tessera:create-artifact", onCreateArtifact);
    window.addEventListener("tessera:run-decay-sweep", onRunDecaySweep);
    window.addEventListener("tessera:trigger-synthesis", onTriggerSynthesis);
    window.addEventListener("tessera:print", onPrint);
    return () => {
      window.removeEventListener("tessera:create-artifact", onCreateArtifact);
      window.removeEventListener("tessera:run-decay-sweep", onRunDecaySweep);
      window.removeEventListener(
        "tessera:trigger-synthesis",
        onTriggerSynthesis,
      );
      window.removeEventListener("tessera:print", onPrint);
    };
    // Registered once for the app's lifetime; latest `navigate` /
    // `addToast` are read from refs above, so the route changing
    // doesn't churn these listeners.
  }, []);
}
