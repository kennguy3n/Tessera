import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ComparisonResultModal, {
  downloadMarkdown,
  formatSimilarity,
  sanitizeForFilename,
} from "../components/ComparisonResultModal";
import type { CompareSourcesResult } from "../types/ipc";

// jsdom (the renderer test env) does NOT ship the URL.createObjectURL
// / revokeObjectURL methods. The browser-download codepath in
// ComparisonResultModal relies on them, so install minimal no-op
// implementations once at module load so `vi.spyOn` can stub them.
// These are restored to no-ops between tests by `mockRestore()`.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", {
    value: (_blob: Blob) => "blob:test",
    configurable: true,
    writable: true,
  });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (_url: string) => {},
    configurable: true,
    writable: true,
  });
}

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const baseResult: CompareSourcesResult = {
  artifact: {
    id: "art-cmp-123",
    title: "Source Comparison",
    artifactType: "document",
    templateId: null,
    content: "# Source Comparison\n\n**Similarity Score:** 42%\n\n",
    citationCount: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    version: 1,
  },
  comparison: {
    similarityScore: 0.42,
    commonThemes: [
      { label: "architecture decisions", frequency: 8 },
      { label: "rollout plan", frequency: 5 },
    ],
    uniqueToA: [{ label: "alpha rationale", frequency: 4 }],
    uniqueToB: [{ label: "beta caveats", frequency: 6 }],
  },
  labelA: "docs-a",
  labelB: "docs-b",
};

describe("ComparisonResultModal", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it("renders the structured comparison instead of the artifact markdown", () => {
    render(
      <MemoryRouter>
        <ComparisonResultModal
          isOpen={true}
          onClose={() => {}}
          result={baseResult}
        />
      </MemoryRouter>,
    );
    // Heading reflects the bridge-side friendly source labels.
    expect(
      screen.getByText("Comparison: docs-a vs docs-b"),
    ).toBeInTheDocument();
    // Similarity rendered as percentage (not raw 0-1 float).
    expect(
      screen.getByTestId("comparison-modal-similarity"),
    ).toHaveTextContent("42%");
    // All three theme groups render with frequency annotations.
    expect(
      screen.getByTestId(
        "comparison-modal-common-item-architecture decisions",
      ),
    ).toHaveTextContent("(8)");
    expect(
      screen.getByTestId("comparison-modal-common-item-rollout plan"),
    ).toHaveTextContent("(5)");
    expect(
      screen.getByTestId("comparison-modal-unique-a-item-alpha rationale"),
    ).toHaveTextContent("(4)");
    expect(
      screen.getByTestId("comparison-modal-unique-b-item-beta caveats"),
    ).toHaveTextContent("(6)");
  });

  it("falls back to a per-section empty message when a theme group has no items", () => {
    const emptyish: CompareSourcesResult = {
      ...baseResult,
      comparison: {
        similarityScore: 0,
        commonThemes: [],
        uniqueToA: [],
        uniqueToB: [],
      },
    };
    render(
      <MemoryRouter>
        <ComparisonResultModal
          isOpen={true}
          onClose={() => {}}
          result={emptyish}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("comparison-modal-common-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("comparison-modal-unique-a-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("comparison-modal-unique-b-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("comparison-modal-similarity"),
    ).toHaveTextContent("0%");
  });

  it("invokes onClose and navigates to the artifact when Open artifact is clicked", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ComparisonResultModal
          isOpen={true}
          onClose={onClose}
          result={baseResult}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("comparison-modal-open-artifact"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/artifacts/art-cmp-123");
  });

  it("invokes onClose when Close is clicked", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ComparisonResultModal
          isOpen={true}
          onClose={onClose}
          result={baseResult}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("comparison-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("triggers a download-blob workflow when Download as Markdown is clicked", () => {
    // jsdom doesn't implement URL.createObjectURL; install spies so
    // the test can assert the standard browser download dance
    // happens (anchor element with download attribute, click, then
    // teardown).
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    const realCreate = document.createElement.bind(document);
    let lastAnchor: HTMLAnchorElement | null = null;
    const createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") {
          lastAnchor = el as HTMLAnchorElement;
          // Avoid jsdom complaining about navigation when click()
          // fires on an anchor with an href.
          (el as HTMLAnchorElement).click = vi.fn();
        }
        return el;
      });

    try {
      render(
        <MemoryRouter>
          <ComparisonResultModal
            isOpen={true}
            onClose={() => {}}
            result={baseResult}
          />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByTestId("comparison-modal-download"));

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(lastAnchor).not.toBeNull();
      expect(lastAnchor!.download).toBe(
        "comparison-docs-a-vs-docs-b.md",
      );
      expect((lastAnchor!.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    } finally {
      createElSpy.mockRestore();
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("does not render when isOpen=false", () => {
    render(
      <MemoryRouter>
        <ComparisonResultModal
          isOpen={false}
          onClose={() => {}}
          result={baseResult}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Comparison:/)).not.toBeInTheDocument();
  });
});

describe("formatSimilarity", () => {
  it("renders score in [0, 1] as a rounded percentage", () => {
    expect(formatSimilarity(0)).toBe("0%");
    expect(formatSimilarity(0.42)).toBe("42%");
    expect(formatSimilarity(0.999)).toBe("100%");
    expect(formatSimilarity(1)).toBe("100%");
  });

  it("clamps values outside [0, 1]", () => {
    expect(formatSimilarity(-0.5)).toBe("0%");
    expect(formatSimilarity(1.5)).toBe("100%");
  });

  it("returns 0% for non-finite scores instead of NaN%", () => {
    expect(formatSimilarity(Number.NaN)).toBe("0%");
    expect(formatSimilarity(Number.POSITIVE_INFINITY)).toBe("0%");
    expect(formatSimilarity(Number.NEGATIVE_INFINITY)).toBe("0%");
  });
});

describe("sanitizeForFilename", () => {
  it("preserves safe labels intact", () => {
    expect(sanitizeForFilename("docs-a")).toBe("docs-a");
    expect(sanitizeForFilename("alpha")).toBe("alpha");
  });

  it("replaces Windows-reserved characters with dash separators", () => {
    // Each reserved char collapses with adjacent ones into a single
    // dash, mirroring the same whitespace-to-dash convention used
    // for the rest of the label (so a filename never carries the
    // reserved punctuation through to the filesystem).
    expect(sanitizeForFilename('a<b>c:d"e/f\\g|h?i*j')).toBe(
      "a-b-c-d-e-f-g-h-i-j",
    );
  });

  it("collapses whitespace into dashes", () => {
    expect(sanitizeForFilename("hello  world\ttab")).toBe("hello-world-tab");
  });

  it("returns 'source' for fully-stripped labels", () => {
    expect(sanitizeForFilename("///")).toBe("source");
    expect(sanitizeForFilename("")).toBe("source");
  });

  it("caps length to keep filename within filesystem limits", () => {
    const longLabel = "a".repeat(120);
    expect(sanitizeForFilename(longLabel).length).toBeLessThanOrEqual(60);
  });

  it("neutralizes DEL and C1 control codepoints alongside C0", () => {
    // Regression: the original implementation only covered the C0
    // control range (\u0000-\u001f). DEL (\u007f) and the C1 control
    // range (\u0080-\u009f) render as garbage in every shell / file
    // picker we've tested, so they should be neutralized into the
    // same dash separator as C0. Confirm both bands collapse cleanly.
    expect(sanitizeForFilename("foo\u007fbar")).toBe("foo-bar");
    expect(sanitizeForFilename("foo\u0080bar")).toBe("foo-bar");
    expect(sanitizeForFilename("foo\u008cbar")).toBe("foo-bar");
    expect(sanitizeForFilename("foo\u009fbar")).toBe("foo-bar");
    // Mixed C0 + DEL + C1 + reserved all collapse into a single dash
    // run, which the `-+/g` pass merges into one separator.
    expect(sanitizeForFilename("a\u0001b\u007fc\u0080d\u009fe")).toBe(
      "a-b-c-d-e",
    );
  });

  it("re-strips trailing dashes that survive the length cap", () => {
    // Regression: a label like "aaa<bbb<ccc<..." (60+ chars of
    // alternating alpha + reserved char) collapses to
    // "aaa-bbb-ccc-..." which after a 60-byte slice could end on a
    // dash. The sanitizer must re-trim trailing dashes AFTER the
    // length cap so the resulting filename never has a dot-or-dash
    // ending that file pickers render as broken.
    const label = "ab<".repeat(30); // 90 chars → collapses to "ab-ab-ab-..."
    const result = sanitizeForFilename(label);
    expect(result.endsWith("-")).toBe(false);
    expect(result.startsWith("-")).toBe(false);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("downloadMarkdown", () => {
  // Use vitest's `MockInstance<Args, Return>` (tuple-Args form)
  // directly instead of `any` to comply with CONTRIBUTING.md's
  // "no any types" rule. The Args tuple mirrors each Web API
  // signature exactly so the `mockRestore()` / `.toHaveBeenCalled*`
  // chain calls typecheck without further casting.
  let createObjectURLSpy: MockInstance<[obj: Blob | MediaSource], string>;
  let revokeObjectURLSpy: MockInstance<[url: string], void>;
  let appendSpy: MockInstance<[node: Node], Node>;
  let removeSpy: MockInstance<[child: Node], Node>;
  let clickedAnchors: HTMLAnchorElement[] = [];
  let createElSpy: MockInstance<
    [tagName: string, options?: ElementCreationOptions],
    HTMLElement
  >;

  beforeEach(() => {
    clickedAnchors = [];
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    appendSpy = vi.spyOn(document.body, "appendChild");
    removeSpy = vi.spyOn(document.body, "removeChild");
    const realCreate = document.createElement.bind(document);
    createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") {
          (el as HTMLAnchorElement).click = vi.fn(() =>
            clickedAnchors.push(el as HTMLAnchorElement),
          );
        }
        return el;
      });
  });

  afterEach(() => {
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    appendSpy.mockRestore();
    removeSpy.mockRestore();
    createElSpy.mockRestore();
  });

  it("clicks an anchor with the requested filename and revokes the URL", () => {
    downloadMarkdown("comparison-x-vs-y.md", "# hi");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(clickedAnchors.length).toBe(1);
    expect(clickedAnchors[0].download).toBe("comparison-x-vs-y.md");
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock");
    // The anchor was attached to the body and torn down — verifies
    // there's no DOM leak after the download.
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes the URL even if the anchor click throws", () => {
    createElSpy.mockRestore();
    const realCreate = document.createElement.bind(document);
    createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") {
          (el as HTMLAnchorElement).click = vi.fn(() => {
            throw new Error("blocked by extension");
          });
        }
        return el;
      });
    expect(() => downloadMarkdown("x.md", "y")).toThrow("blocked");
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
  });
});
