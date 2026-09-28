import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FindReplace } from "./FindReplace";
import { TitlePageDialog } from "./TitlePageDialog";
import { CardsBoard } from "./CardsBoard";
import { PreviewPane } from "./PreviewPane";
import { ReportsPanel } from "./ReportsPanel";
import { parseScreenplay } from "@/lib/fountain/spec";

afterEach(cleanup);
it("finds the first hit, wraps navigation and performs literal replacement", () => {
  const focus = vi.fn(); const changed = vi.fn();
  function Harness() { const [text, setText] = useState("Mara and MARA"); return <FindReplace text={text} onReplace={(next) => { changed(next); setText(next); }} onFocus={focus} onClose={vi.fn()} />; }
  render(<Harness />);
  fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "mara" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(focus).toHaveBeenLastCalledWith(0, 4);
  fireEvent.click(screen.getByRole("button", { name: "Prev" })); expect(focus).toHaveBeenLastCalledWith(9, 13);
  fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "$&" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace all" })); expect(changed).toHaveBeenLastCalledWith("$& and $&");
});

it("edits a multiline title field without deleting custom metadata or changing the body", () => {
  const text = 'Title: Exact\r\nAuthors: A\r\n    B\r\nCustom: Keep\r\n\r\nINT. ROOM - DAY\n\nAction.';
  const apply = vi.fn(); render(<TitlePageDialog open text={text} onClose={vi.fn()} onApply={apply} />);
  expect(screen.getByLabelText('Authors')).toHaveValue('A\nB');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
  expect(apply).toHaveBeenCalledWith(text.replace('Title: Exact', 'Title: New'));
});

it("saves a card synopsis and keeps both scenes navigable", () => {
  const text = 'INT. ROOM - DAY\r\n\r\nMARA\r\nHello.\r\n\r\nEXT. ROAD - NIGHT\r\n\r\nRain.';
  const changed = vi.fn(), open = vi.fn();
  function Harness() { const [value, setValue] = useState(text); return <CardsBoard text={value} onChange={(next) => { changed(next); setValue(next); }} onOpenScene={open} />; }
  render(<Harness />);
  const input = screen.getAllByRole('textbox')[0];
  fireEvent.change(input, { target: { value: 'A turning point.' } }); fireEvent.blur(input);
  const next = changed.mock.calls[0][0] as string;
  expect(parseScreenplay(next).scenes).toHaveLength(2);
  expect(parseScreenplay(next).scenes[0].synopsis).toBe('A turning point.');
  fireEvent.click(screen.getByRole('button', { name: /EXT\. ROAD - NIGHT/ }));
  expect(open).toHaveBeenCalledWith(next.indexOf('EXT. ROAD'));
});

it("previews literal text, source jumps and scene/character reports", () => {
  const text = 'Title: Draft\r\n\r\nINT. ROOM - DAY #7#\r\n\r\nMARA\r\nA \\*literal\\* word.\r\n';
  const jump = vi.fn(); const view = render(<PreviewPane text={text} sceneNumbers onJump={jump} />);
  fireEvent.click(screen.getByText(/INT\. ROOM - DAY/));
  expect(jump).toHaveBeenCalledWith(text.indexOf('INT. ROOM'));
  expect(screen.getByText(/A \*literal\* word\./)).toBeVisible();
  view.rerender(<ReportsPanel text={text} title="Draft" sceneNumbers />);
  const tables = screen.getAllByRole('table');
  expect(within(tables[0]).getByText('MARA')).toBeVisible();
  expect(within(tables[1]).getByText('INT. ROOM - DAY')).toBeVisible();
  expect(within(tables[2]).getByText('ROOM')).toBeVisible();
});
