import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RelevanceBadge, {
  classifyRelevance,
} from "../components/RelevanceBadge";

describe("classifyRelevance", () => {
  it("returns 'high' for scores >= 0.7", () => {
    expect(classifyRelevance(1.0)).toBe("high");
    expect(classifyRelevance(0.85)).toBe("high");
    expect(classifyRelevance(0.7)).toBe("high");
  });

  it("returns 'medium' for scores in [0.3, 0.7)", () => {
    expect(classifyRelevance(0.69)).toBe("medium");
    expect(classifyRelevance(0.5)).toBe("medium");
    expect(classifyRelevance(0.3)).toBe("medium");
  });

  it("returns 'low' for scores < 0.3", () => {
    expect(classifyRelevance(0.29)).toBe("low");
    expect(classifyRelevance(0.1)).toBe("low");
    expect(classifyRelevance(0.0001)).toBe("low");
    expect(classifyRelevance(0)).toBe("low");
  });

  it("treats NaN/Infinity as 'low' (defensive)", () => {
    expect(classifyRelevance(Number.NaN)).toBe("low");
    expect(classifyRelevance(Number.POSITIVE_INFINITY)).toBe("low");
    expect(classifyRelevance(Number.NEGATIVE_INFINITY)).toBe("low");
  });
});

describe("RelevanceBadge", () => {
  it("renders 'Relevance NN%' with the high tier for a score of 0.9", () => {
    render(<RelevanceBadge score={0.9} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge).toHaveAttribute("data-tier", "high");
    expect(badge.textContent).toMatch(/Relevance\s*90%/);
    expect(badge).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Relevance: 90% — High/),
    );
  });

  it("renders the medium tier for a score of 0.5", () => {
    render(<RelevanceBadge score={0.5} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge).toHaveAttribute("data-tier", "medium");
    expect(badge.textContent).toMatch(/Relevance\s*50%/);
    expect(badge).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Relevance: 50% — Medium/),
    );
  });

  it("renders the low tier for a score of 0.1", () => {
    render(<RelevanceBadge score={0.1} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge).toHaveAttribute("data-tier", "low");
    expect(badge.textContent).toMatch(/Relevance\s*10%/);
    expect(badge).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Relevance: 10% — Low/),
    );
  });

  it("clamps scores above 1 to 100% rather than showing >100% (defensive)", () => {
    render(<RelevanceBadge score={1.5} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge.textContent).toMatch(/Relevance\s*100%/);
    // 1.5 still classifies as 'high' (>= 0.7), so the tier doesn't
    // get marked as `low` from the clamp.
    expect(badge).toHaveAttribute("data-tier", "high");
  });

  it("clamps negative scores to 0% and tier 'low'", () => {
    render(<RelevanceBadge score={-0.5} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge.textContent).toMatch(/Relevance\s*0%/);
    expect(badge).toHaveAttribute("data-tier", "low");
  });

  it("uses the inline variant when requested", () => {
    render(<RelevanceBadge score={0.8} variant="inline" />);
    const badge = screen.getByTestId("relevance-badge");
    // Inline variant has a colored dot (aria-hidden) and the text.
    const hidden = badge.querySelector("[aria-hidden='true']");
    expect(hidden).not.toBeNull();
    expect(badge.textContent).toMatch(/Relevance\s*80%/);
  });

  it("rounds percentages rather than truncating (so 0.667 renders as 67%, not 66%)", () => {
    render(<RelevanceBadge score={0.667} />);
    const badge = screen.getByTestId("relevance-badge");
    expect(badge.textContent).toMatch(/Relevance\s*67%/);
  });
});
