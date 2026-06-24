/**
 * Tessera Sources rightbar view.
 *
 * Renders a small list of KChat channels Tessera has indexed plus
 * an action row that ingests the current channel. The component is
 * intentionally minimal — it owns no business logic beyond fetching
 * the rows from the Tessera localhost API and dispatching three
 * intents back to it:
 *
 *   - "Ingest this channel" → `POST /api/ingest-channel`
 *   - "Open source in Tessera" → `tessera://source/<id>` deeplink
 *   - "Refresh" → `GET /api/sources`
 *
 * Drawing primitives are imported from the KChat Desktop SDK's
 * `view` module so the look matches the host. Tests render the
 * component against the JSDOM React 18 root.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  TesseraLocalApiClient,
  TesseraLocalApiHttpError,
  TesseraLocalApiUnavailableError,
} from "../client";
import type { TesseraKchatSourceRow, TesseraLocalApiStatus } from "../types";

export interface SourcesPanelHostBridge {
  /** Read the discovery file managed by Tessera. */
  readPortFile(): Promise<string | null>;
  /** Open a `tessera://` URL via the host's secure-shell helper. */
  openExternal(url: string): Promise<void>;
  /** The current channel id, when the user is viewing a conversation. */
  currentChannelId: string | null;
  currentChannelName: string | null;
  currentTeamId: string | null;
}

export interface SourcesPanelProps {
  bridge: SourcesPanelHostBridge;
  /** Test seam — inject a pre-built client. */
  client?: TesseraLocalApiClient;
}

interface PanelData {
  status: TesseraLocalApiStatus;
  sources: readonly TesseraKchatSourceRow[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; data: PanelData };

export function TesseraSourcesPanel(props: SourcesPanelProps): ReactElement {
  const { bridge } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pendingIngest, setPendingIngest] = useState(false);

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const client = props.client ?? (await buildClient(bridge.readPortFile));
      const [status, sources] = await Promise.all([
        client.status(),
        client.listSources(),
      ]);
      setState({ kind: "ready", data: { status, sources } });
    } catch (err) {
      setState({
        kind: "unavailable",
        reason: describeError(err),
      });
    }
  }, [bridge.readPortFile, props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onIngestCurrent = useCallback(async () => {
    if (!bridge.currentChannelId || !bridge.currentChannelName) return;
    setPendingIngest(true);
    try {
      const client = props.client ?? (await buildClient(bridge.readPortFile));
      await client.ingestChannel({
        channelId: bridge.currentChannelId,
        channelName: bridge.currentChannelName,
        teamId: bridge.currentTeamId ?? undefined,
      });
      await refresh();
    } catch {
      // The error surfaces on the next refresh tick.
      await refresh();
    } finally {
      setPendingIngest(false);
    }
  }, [
    bridge.currentChannelId,
    bridge.currentChannelName,
    bridge.currentTeamId,
    bridge.readPortFile,
    props.client,
    refresh,
  ]);

  const onOpenSource = useCallback(
    (row: TesseraKchatSourceRow) => {
      void bridge.openExternal(row.tesseraDeeplink);
    },
    [bridge],
  );

  return (
    <section className="tessera-sources-panel" aria-label="Tessera Sources">
      <header className="tessera-sources-panel__header">
        <h2>Tessera Sources</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh Tessera sources"
          disabled={state.kind === "loading"}
        >
          Refresh
        </button>
      </header>
      {state.kind === "loading" && (
        <p className="tessera-sources-panel__loading">Connecting to Tessera…</p>
      )}
      {state.kind === "unavailable" && (
        <UnavailableBlock reason={state.reason} onRetry={refresh} />
      )}
      {state.kind === "ready" && (
        <ReadyBlock
          data={state.data}
          currentChannelId={bridge.currentChannelId}
          currentChannelName={bridge.currentChannelName}
          pendingIngest={pendingIngest}
          onIngestCurrent={onIngestCurrent}
          onOpenSource={onOpenSource}
        />
      )}
    </section>
  );
}

function UnavailableBlock(props: {
  reason: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div role="status" className="tessera-sources-panel__unavailable">
      <p>Tessera is not running on this machine.</p>
      <p className="tessera-sources-panel__hint">{props.reason}</p>
      <button type="button" onClick={() => void props.onRetry()}>
        Retry
      </button>
    </div>
  );
}

function ReadyBlock(props: {
  data: PanelData;
  currentChannelId: string | null;
  currentChannelName: string | null;
  pendingIngest: boolean;
  onIngestCurrent: () => void;
  onOpenSource: (row: TesseraKchatSourceRow) => void;
}): ReactElement {
  const { data } = props;
  const alreadyIndexed = props.currentChannelId
    ? data.sources.some((row) => row.channelId === props.currentChannelId)
    : false;
  return (
    <>
      <div
        className="tessera-sources-panel__status"
        aria-label="Tessera connection status"
      >
        <span
          className={
            data.status.connected
              ? "tessera-sources-panel__dot tessera-sources-panel__dot--ok"
              : "tessera-sources-panel__dot tessera-sources-panel__dot--idle"
          }
          aria-hidden
        />
        <span>
          {data.status.connected
            ? `Tessera ${data.status.tesseraVersion} connected`
            : `Tessera ${data.status.tesseraVersion} (disconnected from KChat)`}
        </span>
      </div>
      {props.currentChannelId && props.currentChannelName && (
        <button
          type="button"
          className="tessera-sources-panel__ingest"
          disabled={props.pendingIngest || alreadyIndexed}
          onClick={() => props.onIngestCurrent()}
        >
          {alreadyIndexed
            ? `Already indexed: ${props.currentChannelName}`
            : props.pendingIngest
              ? "Ingesting…"
              : `Ingest #${props.currentChannelName}`}
        </button>
      )}
      <ul
        className="tessera-sources-panel__list"
        aria-label="Indexed KChat sources"
      >
        {data.sources.length === 0 && (
          <li className="tessera-sources-panel__empty">
            No channels indexed yet.
          </li>
        )}
        {data.sources.map((row) => (
          <li key={row.sourceId}>
            <button
              type="button"
              onClick={() => props.onOpenSource(row)}
              className="tessera-sources-panel__row"
              aria-label={`Open source ${row.channelName} in Tessera`}
            >
              <span className="tessera-sources-panel__row-name">
                #{row.channelName}
              </span>
              <span
                className={`tessera-sources-panel__row-state tessera-sources-panel__row-state--${row.state}`}
              >
                {row.state}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

async function buildClient(
  read: () => Promise<string | null>,
): Promise<TesseraLocalApiClient> {
  const { readPortFile } = await import("../portFile");
  const result = await readPortFile({ read });
  if (!result.ok) {
    throw new TesseraLocalApiUnavailableError(
      `Tessera port file is ${result.reason}${result.detail ? `: ${result.detail}` : ""}.`,
    );
  }
  return new TesseraLocalApiClient({ portFile: result.value });
}

function describeError(err: unknown): string {
  if (err instanceof TesseraLocalApiHttpError) {
    return `Tessera returned ${err.status} (${err.body.code}).`;
  }
  if (err instanceof TesseraLocalApiUnavailableError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
