import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rocket } from "lucide-react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import StatusBadge from "../components/StatusBadge";
import OnboardingWizard from "../components/OnboardingWizard";
import { useRecentArtifacts } from "../hooks/useArtifacts";
import { useSourceList } from "../hooks/useSources";
import { useSettings } from "../hooks/useSettings";
import type { SourceInfo } from "../types/ipc";

/**
 * Canonical list of source statuses surfaced by
 * `tessera_core::SourceStatus`. Centralized here (instead of derived
 * from the live source list) so the HomePage breakdown card renders
 * a stable ordering — `indexed` first as the happy-path bucket,
 * `error` and `disconnected` last so the user can spot problems at
 * a glance. The order also matches the badge color hierarchy
 * (success → warning → error / muted), which keeps the visual scan
 * predictable when the counts shift between renders.
 */
const SOURCE_STATUS_ORDER: ReadonlyArray<string> = [
  "indexed",
  "indexing",
  "connected",
  "error",
  "disconnected",
];

/**
 * Build a count map keyed by source status. Statuses present on
 * `SOURCE_STATUS_ORDER` are seeded at zero so a status that has
 * dropped to zero (e.g. the last `error` source was just removed)
 * still renders explicitly as `[error: 0]` rather than silently
 * disappearing. Statuses NOT on the canonical list (forward-compat
 * for any future Rust-side `SourceStatus` variant) are appended
 * after the canonical buckets so they remain visible.
 */
function countByStatus(sources: SourceInfo[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const status of SOURCE_STATUS_ORDER) {
    counts.set(status, 0);
  }
  for (const s of sources) {
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  }
  // Render canonical statuses first (stable order), then any
  // unknown statuses (alphabetical) so a Rust-side enum addition
  // surfaces in the UI on day one instead of disappearing until
  // the renderer is patched.
  const canonical = SOURCE_STATUS_ORDER.map(
    (s) => [s, counts.get(s) ?? 0] as [string, number],
  );
  const extras = Array.from(counts.entries())
    .filter(([s]) => !SOURCE_STATUS_ORDER.includes(s))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...canonical, ...extras];
}

export default function HomePage() {
  const navigate = useNavigate();
  const { recent, loading: artifactsLoading } = useRecentArtifacts();
  const { sources, loading: sourcesLoading } = useSourceList();
  const { settings, loading: settingsLoading, refresh: refreshSettings } =
    useSettings();
  // Local optimistic flag so a successful Skip / Finish closes the
  // wizard immediately even if `refreshSettings()` is still in flight.
  // The IPC write has already succeeded by the time `onDismiss` fires
  // (see `OnboardingWizard.dismiss()`), so this never races against
  // the persisted state.
  const [wizardDismissed, setWizardDismissed] = useState(false);

  const hasSources = sources.length > 0;
  const hasArtifacts = recent.length > 0;
  const isLoading = artifactsLoading || sourcesLoading || settingsLoading;

  // Phase 15 Task 19: gate the wizard on all three signals.
  // `settingsLoading` is intentionally included so we never flash the
  // wizard before the persisted flag has loaded — the loading block
  // below covers that interval with a generic "Loading..." instead.
  const shouldShowWizard =
    !settingsLoading &&
    !wizardDismissed &&
    !settings.onboardingCompleted &&
    !hasSources &&
    !hasArtifacts;

  // source-status breakdown — `useMemo` so the
  // count map is stable across renders that don't actually mutate
  // the source list (otherwise the breakdown row's badge elements
  // re-mount on every parent re-render, which makes the React
  // DevTools profile noisy and would defeat any future
  // memoized-child optimization downstream).
  const statusBreakdown = useMemo(() => countByStatus(sources), [sources]);
  const indexedFiles = useMemo(
    () => sources.reduce((sum, s) => sum + s.fileCount, 0),
    [sources],
  );

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Home" description="Your productivity workspace" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!hasSources && !hasArtifacts) {
    return (
      <div>
        <PageHeader title="Home" description="Your productivity workspace" />
        {shouldShowWizard && (
          <OnboardingWizard
            onDismiss={() => {
              setWizardDismissed(true);
              void refreshSettings();
            }}
          />
        )}
        <EmptyState
          icon={<Rocket size={48} strokeWidth={1.5} aria-hidden="true" />}
          title="Welcome to Tessera"
          message="Get started by adding your first source — a local folder or file — then create artifacts from your data."
          action={
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button onClick={() => navigate("/sources")}>Add Source</Button>
              <Button variant="secondary" onClick={() => navigate("/create")}>
                Explore Templates
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Home"
        description="Your productivity workspace"
        actions={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button onClick={() => navigate("/create")}>New Document</Button>
            <Button variant="secondary" onClick={() => navigate("/sources")}>
              Add Source
            </Button>
          </div>
        }
      />

      {/* quick-actions row. The header above
          carries the two highest-frequency actions (create / add);
          this row carries the navigation shortcuts to other product
          surfaces so the user can land on Tasks, Browse Templates,
          or Settings in one click instead of opening the sidebar.
          Kept as plain buttons (not a separate card) so the row
          stays visually subordinate to the data-bearing sections
          below. */}
      <section
        aria-label="Quick actions"
        style={{
          display: "flex",
          gap: "var(--spacing-sm)",
          flexWrap: "wrap",
          marginBottom: "var(--spacing-xl)",
        }}
      >
        <Button variant="secondary" onClick={() => navigate("/create")}>
          Browse Templates
        </Button>
        <Button variant="secondary" onClick={() => navigate("/tasks")}>
          Tasks
        </Button>
        <Button variant="secondary" onClick={() => navigate("/sources")}>
          Manage Sources
        </Button>
        <Button variant="secondary" onClick={() => navigate("/settings")}>
          Settings
        </Button>
      </section>

      <section
        aria-label="Sources summary"
        style={{ marginBottom: "var(--spacing-xl)" }}
      >
        <h2 style={{ marginBottom: "var(--spacing-md)" }}>Sources</h2>
        <div
          style={{
            display: "flex",
            gap: "var(--spacing-md)",
            flexWrap: "wrap",
          }}
        >
          <Card>
            <div className="card-title">{sources.length}</div>
            <div className="card-description">Connected sources</div>
          </Card>
          <Card>
            <div className="card-title">{indexedFiles}</div>
            <div className="card-description">Indexed files</div>
          </Card>
        </div>

        {/* status-breakdown row. Renders the
            count for every canonical `SourceStatus` variant —
            including the zero buckets — so the user can see at a
            glance whether anything needs attention (e.g. a
            disconnected Google Drive token that has expired, an
            indexing source still in flight). `data-testid` is
            wired so the renderer regression test can assert each
            bucket independently. */}
        <div
          data-testid="source-status-breakdown"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-md)",
          }}
        >
          {statusBreakdown.map(([status, count]) => (
            <div
              key={status}
              data-testid={`source-status-${status}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.375rem",
              }}
            >
              <StatusBadge status={status} />
              <span
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {count}
              </span>
            </div>
          ))}
        </div>
      </section>

      {hasArtifacts && (
        <section aria-label="Recent artifacts">
          <h2 style={{ marginBottom: "var(--spacing-md)" }}>Recent Artifacts</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "var(--spacing-md)",
            }}
          >
            {recent.map((artifact) => (
              <Card
                key={artifact.id}
                // recent-artifact cards become
                // navigable shortcuts to the artifact detail page.
                // The `Card` component already wires role="button",
                // `tabIndex`, focus styles, and Enter/Space
                // activation when an `onClick` is provided, so the
                // accessibility surface comes for free without
                // having to re-implement it inline.
                data-testid={`recent-artifact-${artifact.id}`}
                onClick={() => navigate(`/artifacts/${artifact.id}`)}
              >
                <div className="card-title">{artifact.title}</div>
                <div className="card-description">
                  {artifact.artifactType} &middot; v{artifact.version} &middot;{" "}
                  {new Date(artifact.updatedAt).toLocaleDateString()}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
