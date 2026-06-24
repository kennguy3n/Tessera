/**
 * Aggregate every navigable entity — artifacts, sources, templates,
 * automations, tasks, and the app's own pages — into the flat
 * {@link QuickSwitchItem} list the global quick switcher (Ctrl/Cmd+O)
 * ranks and renders.
 *
 * Every list is fetched from the live `window.tessera.*` bridge via
 * the same hooks the dedicated pages use, so the switcher never
 * carries a hand-maintained fixture and always reflects the real
 * library. Pages are the one synthetic kind, derived from the
 * `SIDEBAR_ITEMS` navigation source of truth.
 *
 * Loading / error / no-bridge are surfaced as aggregate flags so the
 * switcher can paint the right state: a spinner while the first
 * fetch is in flight, a privacy-safe inline error if a list failed,
 * or a "bridge unavailable" notice when running outside Electron.
 *
 * This hook is mounted lazily (only after the user first opens the
 * switcher) so its five IPC round-trips never run for a session that
 * never invokes it — matching the command palette's lazy-mount.
 */

import { useCallback, useMemo } from "react";
import { useArtifactList } from "./useArtifacts";
import { useSourceList } from "./useSources";
import { useTemplateList } from "./useTemplates";
import { useAutomationList } from "./useAutomations";
import { useTaskList } from "./useTasks";
import { SIDEBAR_ITEMS } from "../navigation";
import { kindLabel, type QuickSwitchItem } from "../utils/quickSwitch";

export interface UseQuickSwitcherItemsResult {
  items: QuickSwitchItem[];
  /** True while any underlying list's first fetch is in flight. */
  loading: boolean;
  /** First non-null error across the lists, or null. */
  error: string | null;
  /** False when `window.tessera` is absent (non-Electron / test stub). */
  hasBridge: boolean;
  /** Re-fetch every list (called when the switcher opens). */
  refreshAll: () => void;
}

/** Last path segment, tolerant of both POSIX and Windows separators. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function useQuickSwitcherItems(): UseQuickSwitcherItemsResult {
  const {
    artifacts,
    loading: artifactsLoading,
    error: artifactsError,
    refresh: refreshArtifacts,
  } = useArtifactList();
  const {
    sources,
    loading: sourcesLoading,
    error: sourcesError,
    refresh: refreshSources,
  } = useSourceList();
  const {
    templates,
    loading: templatesLoading,
    error: templatesError,
    refresh: refreshTemplates,
  } = useTemplateList();
  const {
    automations,
    loading: automationsLoading,
    error: automationsError,
    refresh: refreshAutomations,
  } = useAutomationList();
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refresh: refreshTasks,
  } = useTaskList();

  const hasBridge = typeof window !== "undefined" && Boolean(window.tessera);

  const items = useMemo<QuickSwitchItem[]>(() => {
    const out: QuickSwitchItem[] = [];

    for (const a of artifacts) {
      out.push({
        id: `artifact:${a.id}`,
        kind: "artifact",
        title: a.title || "(untitled)",
        subtitle: `${kindLabel("artifact")} · ${a.artifactType}`,
        keywords: a.artifactType,
        to: `/artifacts/${a.id}/edit`,
        recentKey: a.id,
      });
    }

    for (const s of sources) {
      out.push({
        id: `source:${s.id}`,
        kind: "source",
        title: baseName(s.path),
        subtitle: `${kindLabel("source")} · ${s.path}`,
        keywords: `${s.sourceType} ${s.path}`,
        to: `/sources/${s.id}`,
      });
    }

    for (const t of tasks) {
      out.push({
        id: `task:${t.id}`,
        kind: "task",
        title: t.title || "(untitled task)",
        subtitle: `${kindLabel("task")} · ${t.status}`,
        keywords: `${t.status} ${t.priority} ${t.description}`,
        to: "/tasks",
      });
    }

    for (const au of automations) {
      out.push({
        id: `automation:${au.id}`,
        kind: "automation",
        title: au.name || "(untitled automation)",
        subtitle: `${kindLabel("automation")} · ${au.enabled ? "enabled" : "disabled"}`,
        keywords: au.enabled ? "enabled active" : "disabled paused",
        to: "/automations",
      });
    }

    for (const tpl of templates) {
      out.push({
        id: `template:${tpl.id}`,
        kind: "template",
        title: tpl.name,
        subtitle: `${kindLabel("template")} · ${tpl.artifactType}`,
        keywords: `${tpl.artifactType} ${tpl.description}`,
        to: `/create?template=${encodeURIComponent(tpl.id)}`,
      });
    }

    for (const nav of SIDEBAR_ITEMS) {
      out.push({
        id: `page:${nav.to}`,
        kind: "page",
        title: nav.label,
        subtitle: kindLabel("page"),
        keywords: nav.to,
        to: nav.to,
      });
    }

    return out;
  }, [artifacts, sources, tasks, automations, templates]);

  const loading =
    artifactsLoading ||
    sourcesLoading ||
    templatesLoading ||
    automationsLoading ||
    tasksLoading;

  const error =
    artifactsError ??
    sourcesError ??
    templatesError ??
    automationsError ??
    tasksError ??
    null;

  const refreshAll = useCallback(() => {
    void refreshArtifacts();
    void refreshSources();
    void refreshTemplates();
    void refreshAutomations();
    void refreshTasks();
  }, [
    refreshArtifacts,
    refreshSources,
    refreshTemplates,
    refreshAutomations,
    refreshTasks,
  ]);

  return { items, loading, error, hasBridge, refreshAll };
}
