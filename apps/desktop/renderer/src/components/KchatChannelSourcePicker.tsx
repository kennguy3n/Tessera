/**
 * "Add KChat channel as source" modal.
 *
 * Lists the user's KChat teams, then channels in the selected team,
 * lets the user preview the channel's file list, and on submit
 * registers the channel as a Tessera source via
 * `sources:addKchatChannel`. The main process downloads the
 * channel's files to a cache directory and runs them through the
 * standard extraction + indexing pipeline.
 *
 * Rendered only when KChat is `connected` — the caller (SourcesPage)
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
import { useToast } from "./toastContext";
import {
  getStoredDefaultTeamId,
  setStoredDefaultTeamId,
} from "./kchatSettingsHelpers";
import type {
  KchatChannelView,
  KchatFileView,
  KchatTeamView,
} from "../../../shared/types";

interface KchatChannelSourcePickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful registration so the parent can refresh. */
  onAdded?: (sourceId: string) => void;
  /** Override `window.tessera.kchat` (used by tests). */
  api?: typeof window.tessera.kchat;
}

export default function KchatChannelSourcePicker({
  isOpen,
  onClose,
  onAdded,
  api,
}: KchatChannelSourcePickerProps) {
  const kchat = api ?? window.tessera?.kchat;
  const toast = useToast();
  const teamId = useId();
  const channelId = useId();

  const [teams, setTeams] = useState<KchatTeamView[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>(
    getStoredDefaultTeamId() ?? "",
  );
  const [channels, setChannels] = useState<KchatChannelView[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [files, setFiles] = useState<KchatFileView[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the current `selectedTeam` through a ref inside the teams-
  // load effect so the effect does NOT need `selectedTeam` in its
  // dependency array. The previous shape included `selectedTeam` and
  // mutated it from inside the effect (`setSelectedTeam(list[0].id)`
  // when no team had been chosen), which made the effect self-
  // triggering: every modal open issued two `kchat:listTeams` IPC
  // calls back-to-back — one before the default selection was
  // resolved, one after — even though the second response was
  // identical to the first. Sixteenth-pass Devin Review flagged the
  // pattern across `KchatChannelSourcePicker`, `ShareToKchatModal`,
  // and (previously) `KchatSettingsCard`. The ref keeps the "pick a
  // default when none is set" semantics intact while removing the
  // self-trigger; the IPC call now fires exactly once per modal
  // open or `kchat` ref change.
  const selectedTeamRef = useRef(selectedTeam);
  useEffect(() => {
    selectedTeamRef.current = selectedTeam;
  }, [selectedTeam]);

  useEffect(() => {
    if (!isOpen || !kchat) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const list = await kchat.listTeams();
        if (cancelled) return;
        setTeams(list);
        if (!selectedTeamRef.current && list[0]) {
          setSelectedTeam(list[0].id);
          setStoredDefaultTeamId(list[0].id);
        }
      } catch (err) {
        if (!cancelled) setError(`Failed to list teams: ${msg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat]);

  useEffect(() => {
    if (!isOpen || !kchat || !selectedTeam) return;
    let cancelled = false;
    setChannels([]);
    setSelectedChannel("");
    (async () => {
      try {
        const list = await kchat.listChannels(selectedTeam);
        if (cancelled) return;
        const sharable = list.filter((c) => c.type === "O" || c.type === "P");
        setChannels(sharable);
        if (sharable[0]) setSelectedChannel(sharable[0].id);
      } catch (err) {
        if (!cancelled) setError(`Failed to list channels: ${msg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, selectedTeam]);

  useEffect(() => {
    if (!isOpen || !kchat || !selectedChannel) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    (async () => {
      try {
        const list = await kchat.listChannelFiles(selectedChannel, 0, 50);
        if (!cancelled) setFiles(list);
      } catch (err) {
        if (!cancelled) setError(`Failed to list files: ${msg(err)}`);
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, selectedChannel]);

  const channelName = useMemo(() => {
    const c = channels.find((x) => x.id === selectedChannel);
    return c?.display_name || c?.name || "";
  }, [channels, selectedChannel]);

  const handleAdd = useCallback(async () => {
    if (!kchat) return;
    if (!selectedChannel || !channelName) {
      setError("Pick a channel first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await kchat.addChannelSource(selectedChannel, channelName);
      toast.addToast(
        `Added KChat channel "${channelName}" as a source`,
        "success",
      );
      onAdded?.(result.sourceId);
      onClose();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }, [kchat, selectedChannel, channelName, toast, onAdded, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add KChat channel as source"
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-md)",
        }}
      >
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}
        >
          Tessera will download and index the files in the selected channel so
          you can search and cite them. Future files added to the channel are
          picked up by the next scheduled sync.
        </p>

        <div>
          <label htmlFor={teamId} style={labelStyle}>
            Team
          </label>
          <select
            id={teamId}
            className="input"
            value={selectedTeam}
            onChange={(e) => {
              setSelectedTeam(e.target.value);
              setStoredDefaultTeamId(e.target.value || null);
            }}
            disabled={teams.length === 0 || busy}
            data-testid="kchat-source-team"
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
          <label htmlFor={channelId} style={labelStyle}>
            Channel
          </label>
          <select
            id={channelId}
            className="input"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            disabled={channels.length === 0 || busy}
            data-testid="kchat-source-channel"
          >
            {channels.length === 0 ? (
              <option value="">No shareable channels</option>
            ) : (
              channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.type === "P" ? "🔒 " : "# ") + (c.display_name || c.name)}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Files preview</div>
          <div
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              maxHeight: "200px",
              overflow: "auto",
              fontSize: "var(--font-size-sm)",
            }}
            data-testid="kchat-source-file-list"
          >
            {loadingFiles ? (
              <div style={{ padding: "var(--spacing-sm)" }}>Loading…</div>
            ) : files.length === 0 ? (
              <div
                style={{
                  padding: "var(--spacing-sm)",
                  color: "var(--color-text-secondary)",
                }}
              >
                No files in this channel yet.
              </div>
            ) : (
              <ul
                style={{
                  margin: 0,
                  padding: "var(--spacing-sm) var(--spacing-md)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--spacing-xs)",
                  listStyle: "none",
                }}
              >
                {files.map((f) => (
                  <li
                    key={f.id}
                    data-testid={`kchat-source-file-${f.id}`}
                    style={{
                      display: "flex",
                      gap: "var(--spacing-sm)",
                      alignItems: "flex-start",
                      padding: "var(--spacing-xs) 0",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      data-testid={`kchat-source-file-${f.id}-icon`}
                      style={{
                        fontSize: "1.25em",
                        lineHeight: "1.1",
                        flex: "0 0 auto",
                        width: "1.5em",
                        textAlign: "center",
                      }}
                    >
                      {fileTypeIcon(f)}
                    </span>
                    <div
                      style={{
                        flex: "1 1 auto",
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <span
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontWeight:
                            "var(--font-weight-medium)" as unknown as number,
                        }}
                        title={f.name}
                      >
                        {f.name}
                      </span>
                      <span
                        data-testid={`kchat-source-file-${f.id}-meta`}
                        style={{
                          color: "var(--color-text-secondary)",
                          fontSize: "calc(var(--font-size-sm) * 0.9)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {formatFileType(f)} · {formatBytes(f.size)} · Uploaded
                        by {formatUploader(f)} on{" "}
                        {formatUploadDate(f.create_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {error && (
          <p
            role="alert"
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-error, #c00)",
            }}
            data-testid="kchat-source-error"
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            gap: "var(--spacing-sm)",
            justifyContent: "flex-end",
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={busy || !selectedChannel}
            data-testid="kchat-source-add"
          >
            {busy ? "Adding…" : "Add as source"}
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * human-friendly type label for the
 * file preview row. Prefers `extension` (3-4 chars, capitalised
 * for visual weight) over the raw `mime_type` because the
 * preview row is space-constrained — `PDF` is friendlier than
 * `application/pdf` at a glance. Falls back to the mime when no
 * extension is present (e.g. uploads from clients that didn't
 * preserve the file extension), and finally to a generic label.
 */
function formatFileType(f: { mime_type?: string; extension?: string }): string {
  if (f.extension) return f.extension.toUpperCase();
  if (f.mime_type) return f.mime_type;
  return "file";
}

/**
 * choose a Unicode glyph that gives a
 * coarse visual hint about the file type. The Tessera renderer
 * does not download file bytes during the preview phase (would
 * waste bandwidth and rate-limit budget for every "add channel
 * as source" modal open), so we cannot show an actual image
 * thumbnail — a glyph is the right scope. The glyph set mirrors
 * the visual language used elsewhere in the Sources surface
 * (📄 for documents, 🖼️ for images, etc.). The icon is rendered
 * inside a fixed-width span so different glyphs don't shift the
 * row baseline.
 */
function fileTypeIcon(f: { mime_type?: string; extension?: string }): string {
  const mime = (f.mime_type ?? "").toLowerCase();
  const ext = (f.extension ?? "").toLowerCase();
  if (
    mime.startsWith("image/") ||
    /^(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif)$/.test(ext)
  ) {
    return "🖼️";
  }
  if (mime.startsWith("video/") || /^(mp4|mov|webm|mkv|avi|m4v)$/.test(ext)) {
    return "🎬";
  }
  if (
    mime.startsWith("audio/") ||
    /^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(ext)
  ) {
    return "🎵";
  }
  if (mime === "application/pdf" || ext === "pdf") return "📕";
  // Note: `csv` and `tsv` are intentionally classified as the
  // text family rather than the spreadsheet family. They are
  // plain-text formats by definition and can be opened in any
  // text editor; tabbing them as "📊 spreadsheet" would surprise
  // users who treat them as data dumps. The classification is
  // load-bearing: the spreadsheet regex below must NOT include
  // `csv`/`tsv` — those land in the text icon bucket here.
  if (
    mime.startsWith("text/") ||
    /^(md|txt|log|json|yaml|yml|xml|csv|tsv|html|css|js|ts|tsx|jsx|rs|py|go|rb|java|c|h|cpp|hpp|sh|toml)$/.test(
      ext,
    )
  ) {
    return "📄";
  }
  if (
    /^(zip|tar|gz|tgz|bz2|7z|rar|xz)$/.test(ext) ||
    mime === "application/zip" ||
    mime === "application/x-tar" ||
    mime === "application/gzip"
  ) {
    return "🗜️";
  }
  if (mime.includes("word") || /^(doc|docx|odt|rtf)$/.test(ext)) return "📝";
  if (
    mime.includes("sheet") ||
    mime.includes("excel") ||
    /^(xls|xlsx|ods)$/.test(ext)
  )
    return "📊";
  if (
    mime.includes("presentation") ||
    mime.includes("powerpoint") ||
    /^(ppt|pptx|odp|key)$/.test(ext)
  )
    return "💽";
  return "📎";
}

/**
 * format an uploader handle for the
 * preview row. Prefers the enriched `uploaderUsername` (from
 * `enrichKchatFileViews` in the main process); falls back to a
 * shortened raw user id when enrichment didn't resolve
 * (transient REST failure, disconnected state). The raw-id
 * fallback shows the first 8 characters so the column stays
 * narrow — the full 26-char id is preserved on the wire and
 * accessible from the row's `title` (devtools) for debugging.
 */
function formatUploader(f: {
  user_id: string;
  uploaderUsername: string | null;
}): string {
  if (f.uploaderUsername) return `@${f.uploaderUsername}`;
  // Defensive: a `user_id` that doesn't look like an opaque
  // KChat object id (e.g. empty string, freshly seeded test
  // data) should never leak through `assertKchatServerObjectId`,
  // but display a stable "unknown" rather than `@` if it ever
  // does.
  if (!f.user_id) return "unknown user";
  // Truncate the raw id for visual fit. The full id is on the
  // wire and can be inspected via devtools; the preview row only
  // needs enough characters to disambiguate one uploader from
  // another at a glance.
  return `@${f.user_id.slice(0, 8)}…`;
}

/**
 * format the upload epoch ms in the
 * user's locale. Uses `Intl.DateTimeFormat` with a fixed shape
 * (`day month year`) so the column width is predictable across
 * locales without being arbitrarily long. A non-finite or
 * non-positive timestamp returns the literal `unknown` so the
 * row stays legible — the IPC layer initialises `create_at`
 * from the server but a future zero-bytes upload (rare) could
 * land with `create_at: 0`, which would otherwise render as
 * `Jan 1, 1970`.
 */
function formatUploadDate(createAt: number): string {
  if (!Number.isFinite(createAt) || createAt <= 0) return "unknown date";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(createAt));
  } catch {
    return "unknown date";
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
