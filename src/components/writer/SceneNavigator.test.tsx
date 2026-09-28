import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFountain } from "@/lib/fountain-parser";
import { parseScreenplay } from "@/lib/fountain/spec";
import { SceneNavigator } from "./SceneNavigator";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const flushRecompute = () => act(() => { vi.advanceTimersByTime(150); });
const props = (text: string, baselineKey = "saved-1") => ({ fountainText: text, parsed: parseFountain(text, { inputMode: "fountain" }), baselineKey, onJump: vi.fn() });

describe("SceneNavigator", () => {
  it("shows saved duplicate headings without an edited badge and detects an equal-word-count edit", () => {
    const text = Array.from({ length: 8 }, (_, index) => `EXT. ROAD - DAY\n\nThe drifter waits ${index} hours.\n\n`).join("");
    const view = render(<SceneNavigator {...props(text)} />);
    flushRecompute();
    expect(screen.getByText("8 scenes")).toBeVisible();
    expect(screen.queryByTitle("Scenes changed since last save")).not.toBeInTheDocument();
    view.rerender(<SceneNavigator {...props(text.replace("waits 3", "walks 3"))} />);
    flushRecompute();
    expect(screen.getByTitle("Scenes changed since last save")).toHaveTextContent("1 edited");
    expect(screen.getAllByText("EDITED")).toHaveLength(1);
  });

  it("jumps to raw scene offsets while displaying clean headings and deduplicated cues", () => {
    const text = "Title: Draft\r\n\r\n/*\r\nINT. COMMENT - DAY\r\n*/\r\n\r\n.Under the lighthouse #A2#\r\n\r\n@The Drifter (V.O.)\r\nGo.\r\n\r\n@THE DRIFTER\r\nWait.\r\n\r\nINT. ROOM - NIGHT\r\n\r\nRain.\r\n";
    const onJump = vi.fn();
    render(<SceneNavigator {...props(text)} screenplay={parseScreenplay(text)} onJump={onJump} />);
    expect(screen.getByText("2 scenes")).toBeVisible();
    expect(screen.getByText("The Drifter")).toBeVisible();
    expect(screen.queryByText(/@THE DRIFTER/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Under the lighthouse/ }));
    expect(onJump).toHaveBeenLastCalledWith(text.indexOf(".Under"));
    fireEvent.click(screen.getByRole("button", { name: /INT\. ROOM - NIGHT/ }));
    expect(onJump).toHaveBeenLastCalledWith(text.indexOf("INT. ROOM"));
  });

  it("resets the baseline on save and draft switch, including a pending live recompute", () => {
    const text = "INT. ROOM - DAY\n\nMara waits.\n", edited = text.replace("waits", "leaves");
    const view = render(<SceneNavigator {...props(text)} />);
    flushRecompute();
    view.rerender(<SceneNavigator {...props(edited)} />);
    flushRecompute();
    expect(screen.getByTitle("Scenes changed since last save")).toHaveTextContent("1 edited");
    view.rerender(<SceneNavigator {...props(edited, "saved-2")} />);
    expect(screen.queryByTitle("Scenes changed since last save")).not.toBeInTheDocument();
    view.rerender(<SceneNavigator {...props(edited.replace("leaves", "returns"), "saved-2")} />);
    const nextDraft = ".A different draft\r\n\r\nA new beginning.\r\n";
    view.rerender(<SceneNavigator {...props(nextDraft, "other-draft")} />);
    flushRecompute();
    expect(screen.getByText("A different draft")).toBeVisible();
    expect(screen.queryByTitle("Scenes changed since last save")).not.toBeInTheDocument();
    expect(screen.queryByText("NEW")).not.toBeInTheDocument();
  });
});
