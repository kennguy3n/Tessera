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
