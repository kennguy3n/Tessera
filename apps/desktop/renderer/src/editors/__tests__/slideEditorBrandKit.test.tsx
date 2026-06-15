import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SlideEditor from "../SlideEditor";
import {
  buildBrandKit,
  emptyBrandKitDraft,
  saveBrandKits,
} from "../slideBrandKit";
import { __resetBrandKitsStoreForTests } from "../useBrandKits";
import type { SlideContent } from "../slideEditorTypes";

beforeEach(() => {
  window.localStorage.clear();
  __resetBrandKitsStoreForTests();
});

/** Seed a resolvable brand kit (base theme "aurora") into the store. */
function seedAcmeKit(): string {
  const draft = emptyBrandKitDraft("aurora");
  draft.name = "Acme Corp";
  draft.colors.accent = "#7c3aed";
  draft.colors.surface = "#ffffff";
  draft.colors.text = "#1e1b2e";
  const result = buildBrandKit(draft, () => "brand-acme");
  if (!result.ok) throw new Error("fixture kit failed to build");
  saveBrandKits([result.brandKit]);
  __resetBrandKitsStoreForTests();
  return result.brandKit.id;
}

/** A one-slide deck wearing the seeded brand kit on the "aurora" theme. */
function brandedDeck(brandKitId: string): string {
  const content: SlideContent = {
    slides: [{ id: "s1", title: "Hello", blocks: [], notes: "" }],
    themeId: "aurora",
    brandKitId,
  };
  return JSON.stringify(content);
}

/** A brand-less deck on a different theme, as a version restore would supply. */
function plainDeck(): string {
  const content: SlideContent = {
    slides: [{ id: "s2", title: "Restored", blocks: [], notes: "" }],
    themeId: "slate",
  };
  return JSON.stringify(content);
}

/** Parse the payload from the most recent onDraftChange call. */
function lastDraft(onDraftChange: ReturnType<typeof vi.fn>): SlideContent {
  const calls = onDraftChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1][0] as string) as SlideContent;
}

/**
 * Flush the editor's mount-time async capability probes
 * (`model.status()` / `imagegen.isAvailable()`) so their state updates
 * settle inside `act` rather than warning after the test body runs.
 */
async function flushMount(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SlideEditor brand kit + deck-replacing operations", () => {
  it("renders an active brand kit on the toolbar trigger", async () => {
    const id = seedAcmeKit();
    render(
      <SlideEditor
        content={brandedDeck(id)}
        onSave={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    await flushMount();
    expect(screen.getByTestId("slide-brand-trigger")).toHaveTextContent(
      "Acme Corp",
    );
  });

  it("detaches the brand kit and switches theme when a template is applied", async () => {
    const user = userEvent.setup();
    const id = seedAcmeKit();
    const onDraftChange = vi.fn();
    render(
      <SlideEditor
        content={brandedDeck(id)}
        onSave={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    await flushMount();

    // The deck starts branded.
    expect(screen.getByTestId("slide-brand-trigger")).toHaveTextContent(
      "Acme Corp",
    );

    // Apply the "Status Report" template (its suggestedTheme is "slate").
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByRole("button", { name: /Status Report/ }));

    // The brand layer is detached and the deck adopts the template's theme.
    expect(screen.getByTestId("slide-brand-trigger")).toHaveTextContent(
      "Customize brand",
    );
    const draft = lastDraft(onDraftChange);
    expect(draft.themeId).toBe("slate");
    expect(draft.brandKitId).toBeUndefined();
  });

  it("dismisses an open brand builder when a template replaces the deck", async () => {
    const user = userEvent.setup();
    const id = seedAcmeKit();
    render(
      <SlideEditor
        content={brandedDeck(id)}
        onSave={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    await flushMount();

    await user.click(screen.getByTestId("slide-brand-trigger"));
    expect(screen.getByTestId("brand-kit-builder")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByRole("button", { name: /Status Report/ }));

    // The modal seeds its draft from the deck at mount, so a deck swap must
    // close it rather than leave it editing a stale draft.
    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
  });

  it("dismisses an open brand builder on version restore (external content change)", async () => {
    const user = userEvent.setup();
    const id = seedAcmeKit();
    const { rerender } = render(
      <SlideEditor
        content={brandedDeck(id)}
        onSave={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    await flushMount();

    await user.click(screen.getByTestId("slide-brand-trigger"));
    expect(screen.getByTestId("brand-kit-builder")).toBeInTheDocument();

    // A version restore feeds a brand-less deck through the `content` prop.
    rerender(
      <SlideEditor
        content={plainDeck()}
        onSave={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    await flushMount();

    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
    expect(screen.getByTestId("slide-brand-trigger")).toHaveTextContent(
      "Customize brand",
    );
  });
});
