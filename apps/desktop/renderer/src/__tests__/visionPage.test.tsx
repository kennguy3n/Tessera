import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";

import VisionPage from "../pages/VisionPage";
import {
  VISION_MODE_OPTIONS,
  DEFAULT_VISION_MAX_TOKENS,
  MIN_VISION_MAX_TOKENS,
  MAX_VISION_MAX_TOKENS,
  buildVisionDocument,
} from "../pages/visionPageUtils";

/**
 * VisionPage — Block E.
 *
 * Tests the end-to-end shape of the page: availability gating,
 * file-picker integration, mode toggle, max-tokens slider,
 * `vision:describe` IPC call, result rendering, error surface,
 * and the Save-as-Document flow that creates an artifact.
 *
 * The renderer setup (`setup.ts`) injects a fully-mocked
 * `window.tessera` object so individual tests just need to flip
 * the mocks they care about with `vi.spyOn` / `mockResolvedValue`.
 */
describe("VisionPage", () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={["/vision"]}>
        <VisionPage />
      </MemoryRouter>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to the test-friendly default — vision available.
    vi.mocked(window.tessera.vision.isAvailable).mockResolvedValue(true);
  });

  it("pins the canonical three modes in describe / OCR / chart order", () => {
    // The mode order shows up in the radiogroup AND in the
    // saved-document title formatter — pin it so renames don't
    // silently break the artifact title contract.
    expect(VISION_MODE_OPTIONS.map((o) => o.id)).toEqual([
      "describe",
      "ocr",
      "chart",
    ]);
    expect(VISION_MODE_OPTIONS.map((o) => o.label)).toEqual([
      "Describe",
      "OCR",
      "Chart",
    ]);
  });

  it("pins the default and bounds of the max-tokens slider", () => {
    expect(DEFAULT_VISION_MAX_TOKENS).toBe(512);
    expect(MIN_VISION_MAX_TOKENS).toBe(64);
    expect(MAX_VISION_MAX_TOKENS).toBe(2048);
    // Default must lie strictly inside the bounds — a regression
    // where someone tightens MAX below the default would silently
    // clamp the slider on mount.
    expect(DEFAULT_VISION_MAX_TOKENS).toBeGreaterThan(MIN_VISION_MAX_TOKENS);
    expect(DEFAULT_VISION_MAX_TOKENS).toBeLessThan(MAX_VISION_MAX_TOKENS);
  });

  it("shows a 'checking availability' card on mount, then unveils the picker once the probe resolves", async () => {
    renderPage();
    // The probe is async — first the checking card is visible.
    expect(
      screen.getByTestId("vision-availability-checking"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("vision-availability-checking"),
    ).not.toBeInTheDocument();
  });

  it("renders the unavailable banner with a Settings shortcut when no VLM is installed", async () => {
    vi.mocked(window.tessera.vision.isAvailable).mockResolvedValue(false);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-unavailable")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("vision-pick-image"),
    ).not.toBeInTheDocument();
    // The Settings button is rendered with a real label so a
    // future a11y / link-rename refactor catches it.
    expect(screen.getByRole("button", { name: /go to settings/i })).toBeInTheDocument();
  });

  it("treats an isAvailable() rejection as 'unavailable' so a broken IPC doesn't leave the page in a stuck-checking state", async () => {
    vi.mocked(window.tessera.vision.isAvailable).mockRejectedValue(
      new Error("bridge offline"),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-unavailable")).toBeInTheDocument();
    });
  });

  it("disables the Analyze button until an image is chosen", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-analyze")).toBeInTheDocument();
    });
    expect(screen.getByTestId("vision-analyze")).toBeDisabled();
  });

  it("calls dialog:pickImage with the documented title and stores the chosen path in the UI", async () => {
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/sample.png",
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    expect(window.tessera.dialog.pickImage).toHaveBeenCalledWith({
      title: "Choose an image to analyse",
    });
    expect(await screen.findByTestId("vision-image-name")).toHaveTextContent(
      "sample.png",
    );
    // Analyze should now be enabled.
    expect(screen.getByTestId("vision-analyze")).not.toBeDisabled();
  });

  it("leaves the chosen image unchanged if the user cancels the picker on a subsequent click", async () => {
    vi.mocked(window.tessera.dialog.pickImage)
      .mockResolvedValueOnce({
        canceled: false,
        filePath: "/some/dir/first.png",
      })
      .mockResolvedValueOnce({ canceled: true, filePath: null });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    expect(await screen.findByTestId("vision-image-name")).toHaveTextContent(
      "first.png",
    );
    await user.click(screen.getByTestId("vision-pick-image"));
    // Still shows the first image — cancel must not clear it.
    expect(screen.getByTestId("vision-image-name")).toHaveTextContent(
      "first.png",
    );
  });

  it("forwards the selected mode + maxTokens to vision:describe and renders the result content", async () => {
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/chart.png",
    });
    vi.mocked(window.tessera.vision.describe).mockResolvedValueOnce({
      content: "Bar chart showing Q3 revenue by region: NA=120, EU=80.",
      stop: true,
      tokensPredicted: 42,
      tokensEvaluated: 305,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    await user.click(await screen.findByTestId("vision-mode-chart"));
    // Bump the slider so we can assert it's forwarded.
    const slider = screen.getByTestId("vision-max-tokens-slider");
    fireEvent.change(slider, { target: { value: "1024" } });
    expect(screen.getByTestId("vision-max-tokens-value")).toHaveTextContent(
      "1024",
    );
    await user.click(screen.getByTestId("vision-analyze"));
    await waitFor(() => {
      expect(window.tessera.vision.describe).toHaveBeenCalledWith({
        imagePath: "/some/dir/chart.png",
        mode: "chart",
        maxTokens: 1024,
      });
    });
    expect(
      await screen.findByTestId("vision-result-content"),
    ).toHaveTextContent(
      "Bar chart showing Q3 revenue by region: NA=120, EU=80.",
    );
  });

  it("surfaces a vision:describe rejection in the error card without crashing the page", async () => {
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/bad.png",
    });
    vi.mocked(window.tessera.vision.describe).mockRejectedValueOnce(
      new Error("Vision sidecar offline"),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    await user.click(await screen.findByTestId("vision-analyze"));
    expect(await screen.findByTestId("vision-error")).toHaveTextContent(
      /Vision sidecar offline/,
    );
    // The result panel should NOT render — a previous error must
    // not leave a stale result visible.
    expect(
      screen.queryByTestId("vision-result-content"),
    ).not.toBeInTheDocument();
  });

  it("disables the Analyze button while a describe call is in flight", async () => {
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/slow.png",
    });
    // A controllable promise so we can assert the button is
    // disabled WHILE the call is in flight.
    let resolveDescribe: (v: {
      content: string;
      stop: boolean;
      tokensPredicted: number;
      tokensEvaluated: number;
    }) => void = () => undefined;
    const describeP = new Promise<{
      content: string;
      stop: boolean;
      tokensPredicted: number;
      tokensEvaluated: number;
    }>((r) => {
      resolveDescribe = r;
    });
    vi.mocked(window.tessera.vision.describe).mockReturnValueOnce(describeP);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    await user.click(await screen.findByTestId("vision-analyze"));
    // While in flight: button shows Analyzing… and is disabled.
    await waitFor(() => {
      expect(screen.getByTestId("vision-analyze")).toBeDisabled();
    });
    expect(screen.getByTestId("vision-analyze")).toHaveTextContent(/Analyzing/);
    resolveDescribe({
      content: "done",
      stop: true,
      tokensPredicted: 1,
      tokensEvaluated: 1,
    });
    await waitFor(() => {
      expect(screen.getByTestId("vision-analyze")).not.toBeDisabled();
    });
  });

  it("creates an artifact + writes the Markdown body when Save-as-Document is clicked", async () => {
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/poster.jpg",
    });
    vi.mocked(window.tessera.vision.describe).mockResolvedValueOnce({
      content: "A vintage travel poster of Lake Tahoe.",
      stop: true,
      tokensPredicted: 12,
      tokensEvaluated: 200,
    });
    vi.mocked(window.tessera.artifacts.create).mockResolvedValueOnce({
      id: "art-7",
      title: "Vision: Describe — poster.jpg",
      artifactType: "document",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // The setup-side ArtifactInfo fixture has more fields,
      // but the page only reads `.id`.
    } as unknown as ReturnType<
      typeof window.tessera.artifacts.create
    > extends Promise<infer T>
      ? T
      : never);
    vi.mocked(window.tessera.artifacts.update).mockResolvedValueOnce(
      {} as unknown as ReturnType<
        typeof window.tessera.artifacts.update
      > extends Promise<infer T>
        ? T
        : never,
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    await user.click(await screen.findByTestId("vision-analyze"));
    await screen.findByTestId("vision-result-content");
    await user.click(screen.getByTestId("vision-save-as-doc"));
    await waitFor(() => {
      expect(window.tessera.artifacts.create).toHaveBeenCalledWith(
        "Vision: Describe — poster.jpg",
        "document",
      );
    });
    // The update should carry the formatted Markdown body —
    // assert the title + content show up, not the literal
    // (which is brittle due to formatting choices).
    const updateArgs = vi.mocked(window.tessera.artifacts.update).mock
      .calls[0];
    expect(updateArgs[0]).toBe("art-7");
    expect(updateArgs[1]).toMatch(/# Vision: Describe — poster\.jpg/);
    expect(updateArgs[1]).toMatch(/A vintage travel poster of Lake Tahoe\./);
  });

  it("uses the mode + maxTokens that were in effect at analysis time when saving as a document, not the live state of the controls", async () => {
    // Devin Review PR #39 pass-1 🟡 finding: after a successful
    // analysis, the mode radio + maxTokens slider remained
    // enabled and the Save-as-Document flow read from the live
    // state instead of the analysis-time snapshot. A user who
    // analysed in `describe` mode at 512 tokens and then nudged
    // the controls to `chart` / 1024 before clicking Save would
    // get an artifact titled "Vision: Chart — file.png" and a
    // provenance header claiming `maxTokens: 1024` despite the
    // body being produced by the describe-at-512 call. Pin the
    // correct behaviour: the artifact must reflect the analysis
    // parameters, not the live controls.
    vi.mocked(window.tessera.dialog.pickImage).mockResolvedValueOnce({
      canceled: false,
      filePath: "/some/dir/snapshot.png",
    });
    vi.mocked(window.tessera.vision.describe).mockResolvedValueOnce({
      content: "Snapshot at analysis time.",
      stop: true,
      tokensPredicted: 12,
      tokensEvaluated: 200,
    });
    vi.mocked(window.tessera.artifacts.create).mockResolvedValueOnce({
      id: "art-snap",
      title: "Vision: Describe — snapshot.png",
      artifactType: "document",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as ReturnType<
      typeof window.tessera.artifacts.create
    > extends Promise<infer T>
      ? T
      : never);
    vi.mocked(window.tessera.artifacts.update).mockResolvedValueOnce(
      {} as unknown as ReturnType<
        typeof window.tessera.artifacts.update
      > extends Promise<infer T>
        ? T
        : never,
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("vision-pick-image")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("vision-pick-image"));
    // Default mode = describe, default maxTokens = 512. Analyse
    // with those defaults.
    await user.click(await screen.findByTestId("vision-analyze"));
    await screen.findByTestId("vision-result-content");
    // After the analysis completes, mutate the live controls.
    // The result panel and Save flow must continue to reflect
    // the analysis-time snapshot, NOT this drifted state.
    await user.click(screen.getByTestId("vision-mode-chart"));
    const slider = screen.getByTestId("vision-max-tokens-slider");
    fireEvent.change(slider, { target: { value: "1024" } });
    // Sanity: the result-meta caption keeps showing the
    // analysis-time max-tokens (512), not the live slider value
    // (1024). Pin the digit explicitly so a regression that swaps
    // the source can't slip past matching on "of \d+".
    expect(
      screen.getByTestId("vision-result-content").parentElement?.textContent,
    ).toMatch(/Tokens predicted: 12 of 512/);
    await user.click(screen.getByTestId("vision-save-as-doc"));
    await waitFor(() => {
      expect(window.tessera.artifacts.create).toHaveBeenCalledWith(
        "Vision: Describe — snapshot.png",
        "document",
      );
    });
    const updateArgs = vi.mocked(window.tessera.artifacts.update).mock
      .calls[0];
    expect(updateArgs[1]).toMatch(/# Vision: Describe — snapshot\.png/);
    // The provenance header must record the analysis-time
    // maxTokens, NOT the live slider value the user nudged
    // afterward.
    expect(updateArgs[1]).toMatch(/512/);
    expect(updateArgs[1]).not.toMatch(/1024/);
    // And the mode in the body / title must be the analysis-time
    // mode (`Describe`), NOT the live radio (`Chart`).
    expect(updateArgs[1]).not.toMatch(/Vision: Chart/);
  });

  it("buildVisionDocument formats a deterministic Markdown body", () => {
    const out = buildVisionDocument({
      imagePath: "/some/path/photo.png",
      mode: "ocr",
      maxTokens: 256,
      result: {
        content: "EXIT 5 — STATE ST.",
        stop: true,
        tokensPredicted: 8,
        tokensEvaluated: 130,
      },
    });
    expect(out.title).toBe("Vision: OCR — photo.png");
    expect(out.markdown).toContain("# Vision: OCR — photo.png");
    expect(out.markdown).toContain("**Source image:** `photo.png`");
    expect(out.markdown).toContain("**Mode:** OCR");
    expect(out.markdown).toContain("**Tokens predicted:** 8 of 256");
    expect(out.markdown).toContain("**Tokens evaluated (prompt + image):** 130");
    expect(out.markdown).toContain("EXIT 5 — STATE ST.");
    // Truncation banner must NOT appear when stop === true.
    expect(out.markdown).not.toContain("truncated");
  });

  it("buildVisionDocument surfaces a truncation banner when stop === false", () => {
    const out = buildVisionDocument({
      imagePath: "C:\\Users\\ken\\Pictures\\sheet.png",
      mode: "chart",
      maxTokens: 64,
      result: {
        content: "{",
        stop: false,
        tokensPredicted: 64,
        tokensEvaluated: 200,
      },
    });
    // Path-basename works for Windows-style backslash separators.
    expect(out.title).toBe("Vision: Chart — sheet.png");
    expect(out.markdown).toContain("Output was truncated");
  });

  it("buildVisionDocument falls back to '_(empty output)_' when the model returns nothing", () => {
    const out = buildVisionDocument({
      imagePath: "/x.png",
      mode: "describe",
      maxTokens: 100,
      result: {
        content: "   \n  \n",
        stop: true,
        tokensPredicted: 0,
        tokensEvaluated: 50,
      },
    });
    expect(out.markdown).toContain("_(empty output)_");
  });
});
