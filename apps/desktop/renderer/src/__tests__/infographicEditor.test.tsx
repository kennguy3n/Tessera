import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import InfographicEditor, {
  buildPreviewHtml,
  parseInfographicContent,
} from "../editors/InfographicEditor";

describe("parseInfographicContent", () => {
  it("returns default content for empty input", () => {
    const parsed = parseInfographicContent("");
    expect(parsed.title).toBe("Untitled Infographic");
    expect(parsed.layout).toBe("vertical");
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(parsed.colorScheme.primary).toBe("#7C3AED");
  });

  it("returns default content for invalid JSON", () => {
    const parsed = parseInfographicContent("not json {{{");
    expect(parsed.title).toBe("Untitled Infographic");
  });

  it("round-trips serialized content", () => {
    const orig = parseInfographicContent("");
    const json = JSON.stringify(orig);
    const reparsed = parseInfographicContent(json);
    expect(reparsed).toEqual(orig);
  });

  it("preserves custom layout and colors", () => {
    const json = JSON.stringify({
      title: "My Infographic",
      layout: "grid",
      colorScheme: { primary: "#FF0000", secondary: "#00FF00", accent: "#0000FF" },
      sections: [{ heading: "A", body: "B" }],
    });
    const parsed = parseInfographicContent(json);
    expect(parsed.layout).toBe("grid");
    expect(parsed.colorScheme.primary).toBe("#FF0000");
    expect(parsed.title).toBe("My Infographic");
    expect(parsed.sections).toHaveLength(1);
  });
});

describe("buildPreviewHtml", () => {
  it("emits an <h1> for the title and a section per entry", () => {
    const html = buildPreviewHtml({
      title: "Top Metrics",
      subtitle: "Q3",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED", secondary: "#0EA5E9", accent: "#F59E0B" },
      sections: [
        { heading: "Revenue", body: "Up 15%", stat: "15%", statLabel: "QoQ" },
        { heading: "Users", body: "10k MAU" },
      ],
    });
    expect(html).toContain("<h1>Top Metrics</h1>");
    expect(html).toContain("Revenue");
    expect(html).toContain("Users");
    expect(html).toContain("Q3");
    expect(html).toContain("infographic-preview-vertical");
    expect(html).toContain("15%");
  });

  it("escapes HTML in user content", () => {
    const html = buildPreviewHtml({
      title: "<script>alert(1)</script>",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "X", body: "X" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("inlines icons via embedIcons", () => {
    const html = buildPreviewHtml({
      title: "T",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ icon: "lucide:check", heading: "Done", body: "" }],
    });
    // embedIcons replaces {{icon:...}} tokens with inline <svg>
    expect(html).not.toContain("{{icon:");
    expect(html).toMatch(/<svg/);
  });

  it("drops malformed icon specs instead of letting them break out of the token", () => {
    // containing `}}` would close the `{{icon:...}}` token prematurely and
    // let arbitrary trailing text (including `<script>`) reach the DOM.
    const html = buildPreviewHtml({
      title: "T",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [
        {
          icon: "lucide:check}}<script>alert(1)</script>{{icon:x",
          heading: "Bad",
          body: "",
        },
      ],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("{{icon:");
  });

  it("falls back to a safe layout class when `layout` is not allowlisted", () => {
    // value is interpolated into a class attribute; a value like
    // `vertical" onclick="alert(1)` would break out of the attribute.
    // The fix is to (a) constrain `layout` to the allowlist on parse, and
    // (b) defence-in-depth re-check inside `buildPreviewHtml`. This test
    // bypasses parse and supplies a hostile layout directly to the HTML
    // builder to assert the second layer holds.
    const html = buildPreviewHtml({
      title: "T",
      // Cast through unknown so TS doesn't reject the hostile literal —
      // we're simulating data that bypassed the parse-time allowlist.
      layout: 'vertical" onclick="alert(1)' as unknown as "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "X", body: "X" }],
    });
    // The breakout fragment must NOT survive — the layout falls back to the
    // safe `vertical` class.
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain('class="infographic infographic-preview-vertical"');
  });
});

describe("parseInfographicContent layout allowlist", () => {
  it("rejects unknown layout values and falls back to vertical", () => {
    const json = JSON.stringify({
      title: "X",
      layout: 'vertical" onclick="alert(1)',
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "A", body: "B" }],
    });
    const parsed = parseInfographicContent(json);
    expect(parsed.layout).toBe("vertical");
  });

  it("accepts each allowlisted layout value verbatim", () => {
    for (const layout of ["vertical", "horizontal", "grid"] as const) {
      const json = JSON.stringify({
        title: "X",
        layout,
        colorScheme: { primary: "#7C3AED" },
        sections: [{ heading: "A", body: "B" }],
      });
      expect(parseInfographicContent(json).layout).toBe(layout);
    }
  });
});

describe("InfographicEditor", () => {
  it("renders the title input and a section card", () => {
    render(<InfographicEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(
      screen.getByLabelText("Infographic title"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Section 1 heading")).toBeInTheDocument();
  });

  it("calls onSave after the debounce when the user types", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    try {
      render(
        <InfographicEditor content="" onSave={onSave} autoSaveMs={50} />,
      );
      fireEvent.change(screen.getByLabelText("Infographic title"), {
        target: { value: "New Title" },
      });
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(onSave).toHaveBeenCalled();
      const saved = JSON.parse(
        (onSave.mock.calls[onSave.mock.calls.length - 1] as [string])[0],
      );
      expect(saved.title).toBe("New Title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a new section when the user clicks 'Add section'", () => {
    render(<InfographicEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(screen.getByLabelText("Section 1 heading")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Add section"));
    expect(screen.getByLabelText("Section 2 heading")).toBeInTheDocument();
  });
});
