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
 *
 * Centralised here (not inline in `App`) so the wiring is unit-
 * testable and `App` stays a thin shell. Mounted once at the app
 * root. Every bridge call is wrapped so a rejected IPC surfaces a
 * privacy-safe toast instead of an unhandled rejection.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../components/toastContext";
import { notifyArtifactsChanged } from "./useArtifacts";
import { ARTIFACT_TYPES } from "../constants/artifactTypes";

export function useGlobalCommandActions(): void {
  const navigate = useNavigate();
  const { addToast } = useToast();

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
        addToast("Can’t create — the desktop bridge is unavailable.", "error");
        return;
      }
      void (async () => {
        try {
          const artifact = await api.artifacts.create(
            spec.defaultTitle,
            spec.id,
          );
          notifyArtifactsChanged();
          navigate(`/artifacts/${artifact.id}/edit`);
        } catch {
          addToast(
            `Couldn’t create the ${spec.label.toLowerCase()}. Please try again.`,
            "error",
          );
        }
      })();
    };

    const onRunDecaySweep = () => {
      const api = bridge();
      if (!api) {
        addToast("Memory tools need the desktop bridge.", "error");
        return;
      }
      void (async () => {
        try {
          const report = await api.substrate.runDecaySweep();
          const archived =
            report.candidatesArchived + report.supersededArchived;
          addToast(
            `Decay sweep done — ${report.scored} scored, ${archived} archived.`,
            "success",
          );
        } catch {
          addToast("Decay sweep failed. Please try again.", "error");
        }
      })();
    };

    const onTriggerSynthesis = () => {
      const api = bridge();
      if (!api) {
        addToast("Memory tools need the desktop bridge.", "error");
        return;
      }
      void (async () => {
        try {
          const summary = await api.substrate.triggerSynthesis();
          addToast(
            summary.recap
              ? `Synthesis complete: ${summary.recap}`
              : `Synthesis complete (v${summary.version}).`,
            "success",
          );
        } catch {
          addToast("Synthesis failed. Please try again.", "error");
        }
      })();
    };

    window.addEventListener("tessera:create-artifact", onCreateArtifact);
    window.addEventListener("tessera:run-decay-sweep", onRunDecaySweep);
    window.addEventListener("tessera:trigger-synthesis", onTriggerSynthesis);
    return () => {
      window.removeEventListener("tessera:create-artifact", onCreateArtifact);
      window.removeEventListener("tessera:run-decay-sweep", onRunDecaySweep);
      window.removeEventListener(
        "tessera:trigger-synthesis",
        onTriggerSynthesis,
      );
    };
  }, [navigate, addToast]);
}
