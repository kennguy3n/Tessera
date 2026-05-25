/**
 * Modal for sharing the current artifact into a KChat channel.
 *
 * Flow:
 *   1. On open, the modal fetches teams (`kchat:listTeams`) and the
 *      channels for the default-team-id from the settings card.
 *   2. The user picks a channel, an export format, and toggles for
 *      "include citations" / "include evidence pack".
 *   3. On submit the modal calls `kchat:shareArtifact`. The IPC
 *      handler runs the existing export pipeline + uploads the
 *      bytes to the channel file store; the renderer never sees
 *      the KChat token.
 *   4. On success, a toast is shown and the modal closes; on
 *      failure the error is rendered inline.
 *
 * The modal is rendered only when KChat is `connected` — the caller
 * gates visibility on `window.tessera.kchat.status()`.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import Modal from "./Modal";
import Button from "./Button";
import { useToast } from "./Toast";
import {
  getStoredDefaultTeamId,
  setStoredDefaultTeamId,
} from "./KchatSettingsCard";
import type {
  KchatChannelView,
  KchatTeamView,
} from "../../../shared/types";

export type KchatShareFormat = "markdown" | "html" | "pdf" | "docx" | "json";

const FORMAT_LABELS: Record<KchatShareFormat, string> = {
  markdown: "Markdown (.md)",
  html: "HTML (.html)",
  pdf: "PDF (.pdf)",
  docx: "Word (.docx)",
  json: "JSON (.json)",
};

interface ShareToKchatModalProps {
  isOpen: boolean;
  onClose: () => void;
  artifactId: string;
  artifactTitle: string;
  /** Formats valid for this artifact type (subset of FORMAT_LABELS keys). */
  availableFormats: KchatShareFormat[];
  /** Default format from the user's settings. */
  defaultFormat: KchatShareFormat;
  /** Optional override of `window.tessera.kchat` (used by tests). */
  api?: typeof window.tessera.kchat;
}

export default function ShareToKchatModal({
  isOpen,
  onClose,
  artifactId,
  artifactTitle,
  availableFormats,
  defaultFormat,
  api,
}: ShareToKchatModalProps) {
  const kchat = api ?? window.tessera?.kchat;
  const toast = useToast();
  const teamSelectId = useId();
  const channelSelectId = useId();
  const formatSelectId = useId();
  const citationsId = useId();
  const evidenceId = useId();

  const [teams, setTeams] = useState<KchatTeamView[]>([]);
  const [teamId, setTeamId] = useState<string>(getStoredDefaultTeamId() ?? "");
  const [channels, setChannels] = useState<KchatChannelView[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [format, setFormat] = useState<KchatShareFormat>(defaultFormat);
  const [includeCitations, setIncludeCitations] = useState(true);
  const [includeEvidencePack, setIncludeEvidencePack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);

  // Read the current `teamId` through a ref inside the teams-load
  // effect so the effect does NOT need `teamId` in its dependency
  // array. The previous shape included `teamId` and mutated it from
  // inside the effect (`setTeamId(list[0].id)` when no team had been
  // chosen), which made the effect self-triggering: every modal
  // open issued two `kchat:listTeams` IPC calls back-to-back — one
  // before the default-team-id was resolved, one after — even
  // though the second response was identical to the first.
  // Sixteenth-pass Devin Review flagged the pattern across
  // `KchatChannelSourcePicker` and `ShareToKchatModal`. The ref
  // keeps the "pick a default when none is set" semantics intact
  // while removing the self-trigger; the IPC call now fires exactly
  // once per modal open or `kchat` ref change.
  const teamIdRef = useRef(teamId);
  useEffect(() => {
    teamIdRef.current = teamId;
  }, [teamId]);

  // Load teams when the modal opens (and stay subscribed so a
  // background "connection lost" → reconnect can refresh the list).
  useEffect(() => {
    if (!isOpen || !kchat) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const list = await kchat.listTeams();
        if (cancelled) return;
        setTeams(list);
        if (!teamIdRef.current && list[0]) {
          setTeamId(list[0].id);
          setStoredDefaultTeamId(list[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to list teams: ${errorMessage(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat]);

  // Load channels whenever the team changes (or modal opens with a
  // pre-selected team).
  useEffect(() => {
    if (!isOpen || !kchat || !teamId) return;
    let cancelled = false;
    setLoadingChannels(true);
    setChannels([]);
    setChannelId("");
    (async () => {
      try {
        const list = await kchat.listChannels(teamId);
        if (cancelled) return;
        // Only show channels the renderer can actually share into
        // — drop direct-message ("D") + group-DM ("G") channels.
        // Sharing into a DM bypasses the channel-membership audit
        // trail and is intentionally not supported.
        const sharable = list.filter(
          (c) => c.type === "O" || c.type === "P",
        );
        setChannels(sharable);
        if (sharable[0]) setChannelId(sharable[0].id);
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to list channels: ${errorMessage(err)}`);
        }
      } finally {
        if (!cancelled) setLoadingChannels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, teamId]);

  const formatOptions = useMemo(
    () => availableFormats.filter((f) => f in FORMAT_LABELS),
    [availableFormats],
  );

  const handleShare = useCallback(async () => {
    if (!kchat) {
      setError("KChat IPC is not available");
      return;
    }
    if (!channelId) {
      setError("Pick a channel to share to");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await kchat.shareArtifact(
        artifactId,
        channelId,
        format,
        includeCitations,
        includeEvidencePack,
      );
      toast.addToast(
        `Shared "${artifactTitle}" to KChat (${result.fileName})`,
        "success",
      );
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [
    kchat,
    channelId,
    artifactId,
    artifactTitle,
    format,
    includeCitations,
    includeEvidencePack,
    toast,
    onClose,
  ]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share to KChat">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
        <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
          Upload <strong>{artifactTitle}</strong> as a file to a KChat
          channel. Channel members will be able to download and
          preview the export directly in KChat. The KChat token never
          leaves the main process.
        </p>

        <div>
          <label htmlFor={teamSelectId} style={labelStyle}>
            Team
          </label>
          <select
            id={teamSelectId}
            className="input"
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setStoredDefaultTeamId(e.target.value || null);
            }}
            disabled={teams.length === 0 || busy}
            data-testid="kchat-share-team"
          >
            {teams.length === 0 ? (
              <option value="">No teams</option>
            ) : (
              teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name || t.name}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label htmlFor={channelSelectId} style={labelStyle}>
            Channel
          </label>
          <select
            id={channelSelectId}
            className="input"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={loadingChannels || channels.length === 0 || busy}
            data-testid="kchat-share-channel"
          >
            {loadingChannels ? (
              <option value="">Loading…</option>
            ) : channels.length === 0 ? (
              <option value="">No shareable channels in this team</option>
            ) : (
              channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.type === "P" ? "🔒 " : "# ") +
                    (c.display_name || c.name)}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label htmlFor={formatSelectId} style={labelStyle}>
            Export format
          </label>
          <select
            id={formatSelectId}
            className="input"
            value={format}
            onChange={(e) => setFormat(e.target.value as KchatShareFormat)}
            disabled={busy}
            data-testid="kchat-share-format"
          >
            {formatOptions.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input
            id={citationsId}
            type="checkbox"
            checked={includeCitations}
            disabled={busy}
            onChange={(e) => setIncludeCitations(e.target.checked)}
            data-testid="kchat-share-citations"
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>
            Include inline citations in the export
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input
            id={evidenceId}
            type="checkbox"
            checked={includeEvidencePack}
            disabled={busy}
            onChange={(e) => setIncludeEvidencePack(e.target.checked)}
            data-testid="kchat-share-evidence"
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>
            Also attach the evidence pack (ZIP of all sources cited)
          </span>
        </label>

        {error && (
          <p
            role="alert"
            style={{ fontSize: "var(--font-size-sm)", color: "var(--color-error, #c00)" }}
            data-testid="kchat-share-error"
          >
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleShare}
            disabled={busy || !channelId}
            data-testid="kchat-share-submit"
          >
            {busy ? "Sharing…" : "Share"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const labelStyle = {
  display: "block",
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--font-weight-medium)" as unknown as number,
  marginBottom: "var(--spacing-xs)",
  color: "var(--color-text-headline)",
} as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
