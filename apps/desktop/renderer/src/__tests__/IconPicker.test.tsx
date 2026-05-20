import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import IconPicker, {
  type IconPickerValue,
} from "../components/IconPicker";

describe("IconPicker", () => {
  it("renders the default lucide tab and a populated grid", () => {
    render(<IconPicker onChange={() => {}} />);
    const luc = screen.getByRole("tab", { name: /lucide/i });
    expect(luc).toHaveAttribute("aria-selected", "true");
    // Some lucide icons (rendered as <button role=option>) should appear.
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
  });

  it("filters icons by search query", () => {
    render(<IconPicker onChange={() => {}} />);
    const search = screen.getByPlaceholderText(/search lucide icons/i);
    fireEvent.change(search, { target: { value: "fold" } });
    const options = screen.getAllByRole("option");
    for (const o of options) {
      expect((o.getAttribute("aria-label") ?? "").toLowerCase()).toMatch(
        /fold/,
      );
    }
  });

  it("switches to phosphor tab and exposes weight selector", () => {
    render(<IconPicker onChange={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /phosphor/i }));
    expect(
      screen.getByRole("tab", { name: /phosphor/i }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText(/phosphor weight/i)).toBeInTheDocument();
  });

  it("calls onChange with a lucide spec when a tile is clicked", () => {
    const onChange = vi.fn();
    render(<IconPicker onChange={onChange} />);
    const search = screen.getByPlaceholderText(/search lucide icons/i);
    fireEvent.change(search, { target: { value: "home" } });
    const home = screen.getByRole("option", { name: "Home" });
    fireEvent.click(home);
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0] as IconPickerValue;
    expect(arg.set).toBe("lucide");
    expect(arg.name).toBe("Home");
    expect(arg.weight).toBeUndefined();
  });

  it("calls onChange with phosphor weight when picking from phosphor tab", () => {
    const onChange = vi.fn();
    render(<IconPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /phosphor/i }));
    fireEvent.change(screen.getByLabelText(/phosphor weight/i), {
      target: { value: "bold" },
    });
    const search = screen.getByPlaceholderText(/search phosphor icons/i);
    fireEvent.change(search, { target: { value: "house" } });
    // The grid is virtualized by react via the listIcons() catalog; query
    // by aria-label which we always set per tile.
    const tile = screen.getByRole("option", { name: "House" });
    fireEvent.click(tile);
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls.at(-1)![0] as IconPickerValue;
    expect(arg.set).toBe("phosphor");
    expect(arg.weight).toBe("bold");
    expect(arg.name).toBe("House");
  });

  it("highlights the currently selected value", () => {
    render(
      <IconPicker
        value={{ set: "lucide", name: "Home" }}
        onChange={() => {}}
      />,
    );
    const search = screen.getByPlaceholderText(/search lucide icons/i);
    fireEvent.change(search, { target: { value: "home" } });
    const home = screen.getByRole("option", { name: "Home" });
    expect(home).toHaveAttribute("aria-selected", "true");
  });
});
