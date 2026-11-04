import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WriterDesk } from "./WriterDesk";
import { localApi } from "../api";
import { buildDraftData, recoveryKey, type RecoveryCopy } from "../model";
import type { DraftRecord, LocalProject } from "../types";
import { exportScreenplayPdf } from "@/lib/fountain/pdf";

const online = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("../api", () => ({ localApi: { history: vi.fn(), save: vi.fn(), recovery: { get: vi.fn(), put: vi.fn(), remove: vi.fn() } }, LocalApiError: class extends Error { code = ""; } }));
vi.mock("./QiMoviPanel", () => ({ QiMoviPanel: () => <div>QiMovi connection</div> }));
vi.mock("./HistoryPanel", () => ({ HistoryPanel: () => <div>History</div> }));
vi.mock("./FilmcraftPanel", () => ({ FilmcraftPanel: ({ active, browse }: { active: boolean; browse: { query?: string } }) => <div data-testid="filmcraft-panel" data-active={active} data-query={browse.query}>Film reference</div> }));
vi.mock("./DevelopmentPanel", async () => {
  const { forwardRef } = await import('react');
  return { DevelopmentPanel: forwardRef(function MockDevelopment({ projectId, draftId, active }: { projectId: string; draftId: string; active: boolean }, _ref) { return <textarea aria-label="Development notes" data-project={projectId} data-draft={draftId} data-active={active} />; }) };
});
vi.mock("./CompetitionPanel", () => { online.loaded(); return { CompetitionPanel: () => <div>Online competition loaded</div> }; });
vi.mock("@/lib/fountain/pdf", () => ({ exportScreenplayPdf: vi.fn() }));

const project: LocalProject = { id: "project:test", title: "Test", profile: "caniscreenwrite-local-writer/v1", sourceHash: null, sourceStatus: "NO_SOURCE" };
const record = (body = "Initial action.", version = 1): DraftRecord => ({ id: "screenplay-draft:test", kind: "screenplay-draft", version, sha256: `hash-${version}`, data: buildDraftData(project.id, { title: "Test", body }) });
const copy = (body = "Recovered work."): RecoveryCopy => ({ schema: "caniscreenwrite-local-writer-recovery/v1", draftId: record().id, baseVersion: 1, baseSha256: "hash-1", data: record(body).data, savedAt: "2026-09-26T12:00:00.000Z" });
const props = (saved = record()) => ({ project, open: { id: saved.id, saved, initial: null }, records: [saved], onSaved: vi.fn(), onRecordsChanged: vi.fn(async () => {}) });
const source = () => { fireEvent.click(screen.getByRole("button", { name: "Fountain" })); return screen.getByRole("textbox", { name: "Fountain screenplay" }) as HTMLTextAreaElement; };
const command = (detail: string) => act(() => { window.dispatchEvent(new CustomEvent("writer:command", { detail })); });

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(localApi.history).mockResolvedValue([record()]);
  vi.mocked(localApi.recovery.get).mockResolvedValue(null);
  vi.mocked(localApi.recovery.put).mockImplementation(async (value) => value);
  vi.mocked(localApi.recovery.remove).mockResolvedValue({ deleted: true });
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); });

it("retains unresolved browser and disk recovery on a clean opening until Restore", async () => {
  const recovery = copy();
  localStorage.setItem(recoveryKey(record().id), JSON.stringify(recovery));
  vi.mocked(localApi.recovery.get).mockResolvedValue(recovery);
  render(<WriterDesk {...props()} />);
  await waitFor(() => expect(localApi.recovery.get).toHaveBeenCalledWith(record().id));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(localStorage.getItem(recoveryKey(record().id))).toContain("Recovered work.");
  expect(localApi.recovery.put).not.toHaveBeenCalled(); expect(localApi.recovery.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(source()).toHaveValue("Recovered work.");
  await waitFor(() => expect(localApi.recovery.put).toHaveBeenCalledWith(expect.objectContaining({ data: recovery.data })));
});

it("offers disk recovery after an origin change with empty browser storage", async () => {
  vi.mocked(localApi.recovery.get).mockResolvedValue(copy());
  render(<WriterDesk {...props()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  expect(source()).toHaveValue("Recovered work.");
});

it("debounces disk edits and flushes the newest pending copy on unmount", async () => {
  const view = render(<WriterDesk {...props()} />);
  await act(async () => {});
  const input = source();
  fireEvent.change(input, { target: { value: "First edit." } });
  fireEvent.change(input, { target: { value: "Newest edit." } });
  expect(localApi.recovery.put).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(localApi.recovery.put).toHaveBeenCalledTimes(1));
  expect(localApi.recovery.put).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: "Newest edit." }) }));
});

it("keeps edits made during save and ignores parent acknowledgements and stale records", async () => {
  let resolve!: (value: DraftRecord) => void;
  vi.mocked(localApi.save).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const initial = props(); const view = render(<WriterDesk {...initial} />);
  await act(async () => {});
  const input = source(); fireEvent.change(input, { target: { value: "Submitted edit." } });
  command("save"); command("save");
  expect(localApi.save).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "New typing during save." } });
  const saved = record("Submitted edit.", 2);
  await act(async () => resolve(saved));
  view.rerender(<WriterDesk {...initial} open={{ id: saved.id, saved, initial: null }} />);
  expect(input).toHaveValue("New typing during save.");
  view.rerender(<WriterDesk {...initial} />);
  expect(input).toHaveValue("New typing during save.");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await waitFor(() => expect(localApi.recovery.put).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 2, data: expect.objectContaining({ body: "New typing during save." }) })));
});

it("offers a conflict for incoming revisions while keeping unsaved text", async () => {
  const initial = props(); const view = render(<WriterDesk {...initial} />);
  await act(async () => {});
  const input = source(); fireEvent.change(input, { target: { value: "My unsaved work." } });
  view.rerender(<WriterDesk {...props(record("Remote edit.", 2))} />);
  expect(input).toHaveValue("My unsaved work.");
  expect(screen.getByRole("button", { name: "Load latest revision" })).toBeVisible();
});

it("wires native commands and gives Find and Export accessible names", async () => {
  render(<WriterDesk {...props()} />); await act(async () => {});
  expect(screen.getByRole("button", { name: "Find and replace" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Export screenplay" })).toBeVisible();
  const input = source(); fireEvent.change(input, { target: { value: "Changed." } });
  command("undo"); expect(input).toHaveValue("Initial action.");
  command("redo"); expect(input).toHaveValue("Changed.");
  command("find"); expect(screen.getByRole("search")).toBeVisible();
  command("export-pdf"); await waitFor(() => expect(exportScreenplayPdf).toHaveBeenCalledWith("Changed.", "Test.pdf", expect.any(Object)));
});

it("uses a timestamp guard for explicit recovery discard", async () => {
  const recovery = copy(); vi.mocked(localApi.recovery.get).mockResolvedValue(recovery);
  render(<WriterDesk {...props()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  await waitFor(() => expect(localApi.recovery.remove).toHaveBeenCalledWith(recovery.draftId, recovery.savedAt));
});

it("does not load the online client just by visiting Connect", async () => {
  render(<WriterDesk {...props()} />); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Connect" }), { button: 0, ctrlKey: false });
  expect(screen.getByRole("button", { name: "Enable online competition" })).toBeVisible();
  expect(online.loaded).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Enable online competition" }));
  expect(await screen.findByText("Online competition loaded")).toBeVisible();
  expect(online.loaded).toHaveBeenCalledTimes(1);
});

it("keeps the web-style modes and makes a narrow workspace's inspector optional", async () => {
  render(<WriterDesk {...props()} />); await act(async () => {});
  const modes = screen.getByRole('tablist', { name: 'Workspace modes' });
  expect(within(modes).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Write', 'Develop', 'World Builder', 'Film language', 'Preview', 'Cards', 'Reports', 'Brands & financing', 'Scoring & profiles', 'History1']);
  expect(screen.queryByRole('button', { name: 'Film language' })).toBeNull();
  const toggle = screen.getByRole('button', { name: 'Inspector' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('complementary', { name: 'Screenplay inspector' })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('complementary', { name: 'Screenplay inspector' })).toHaveAttribute('id', toggle.getAttribute('aria-controls'));
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Details' }), { button: 0, ctrlKey: false });
  fireEvent.change(screen.getByRole('textbox', { name: 'Genre' }), { target: { value: 'Mystery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  expect(screen.getByRole('textbox', { name: 'Genre' })).toHaveValue('Mystery');
});

it("starts with context visible on a wide desktop and preserves that choice across focus mode", async () => {
  const media = window.matchMedia('(min-width: 1280px)');
  vi.spyOn(window, 'matchMedia').mockReturnValue({ ...media, matches: true });
  const view = render(<WriterDesk {...props()} />); await act(async () => {});
  const root = view.container.querySelector('.lw-workspace');
  expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1280px)');
  expect(screen.getByRole('button', { name: 'Inspector' })).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }));
  expect(root).toHaveAttribute('data-focus', 'true');
  expect(screen.queryByRole('tablist', { name: 'Workspace modes' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: 'Screenplay inspector' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(root).toHaveAttribute('data-focus', 'false');
  expect(screen.getByRole('tablist', { name: 'Workspace modes' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Inspector' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Focus mode' })).toHaveFocus();
});

it("lets Find and other dialogs consume Escape before exiting focus mode", async () => {
  const initial = props();
  const view = render(<><WriterDesk {...initial} /></>); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }));
  command('find');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Escape' });
  expect(screen.queryByRole('search')).toBeNull();
  expect(screen.getByRole('button', { name: 'Exit focus mode' })).toBeVisible();
  view.rerender(<><WriterDesk {...initial} /><div role="dialog" aria-label="Another dialog">Dialog</div></>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Exit focus mode' })).toBeVisible();
  view.rerender(<><WriterDesk {...initial} /></>);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Focus mode' })).toBeVisible();
});

it("leaves hidden work durable without intercepting keyboard or desktop commands", async () => {
  const initial = props();
  const view = render(<WriterDesk {...initial} />); await act(async () => {});
  const input = source();
  fireEvent.change(input, { target: { value: 'Retain this hidden edit.' } });
  input.focus();
  view.rerender(<WriterDesk {...initial} active={false} />);
  expect(view.container.querySelector('.lw-workspace')).not.toBeVisible();
  expect(input).not.toHaveFocus();
  const host = window as unknown as { __localWriterDirty: boolean; __flushWriterRecovery: () => Promise<void> };
  expect(host.__localWriterDirty).toBe(true);
  for (const detail of ['find', 'undo', 'redo', 'save', 'export-pdf']) command(detail);
  const key = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(key); });
  expect(key.defaultPrevented).toBe(false);
  expect(fireEvent.keyDown(window, { key: 's', metaKey: true, cancelable: true })).toBe(true);
  expect(view.container.querySelector('[role="search"]')).toBeNull();
  expect(input).toHaveValue('Retain this hidden edit.');
  expect(localApi.save).not.toHaveBeenCalled();
  expect(exportScreenplayPdf).not.toHaveBeenCalled();
  await act(async () => host.__flushWriterRecovery());
  expect(localApi.recovery.put).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: 'Retain this hidden edit.' }) }));
  expect(host.__localWriterDirty).toBe(true);
  view.rerender(<WriterDesk {...initial} />);
  command('undo'); expect(input).toHaveValue('Initial action.');
  command('redo'); expect(input).toHaveValue('Retain this hidden edit.');
});

it("deactivates mounted development when navigating away and restores its unsaved notes", async () => {
  const initial = props(); const view = render(<WriterDesk {...initial} />); await act(async () => {});
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Develop' }), { button: 0, ctrlKey: false });
  const input = screen.getByRole('textbox', { name: 'Development notes' });
  fireEvent.change(input, { target: { value: 'Continue this idea.' } });
  expect(input).toHaveAttribute('data-active', 'true');
  view.rerender(<WriterDesk {...initial} active={false} />);
  expect(input).toHaveAttribute('data-active', 'false');
  view.rerender(<WriterDesk {...initial} />);
  expect(input).toBeVisible();
  expect(input).toHaveValue('Continue this idea.');
  expect(input).toHaveAttribute('data-active', 'true');
});

it("carries a selected screenplay term into the Film language tab", async () => {
  const initial = props(); const view = render(<WriterDesk {...initial} />); await act(async () => {});
  const input = source();
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  act(() => input.focus());
  fireEvent.mouseDown(input); input.setSelectionRange(0, 7); fireEvent.mouseUp(input); fireEvent.select(input);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Film language' }), { button: 0, ctrlKey: false });
  expect(screen.getByTestId('filmcraft-panel')).toHaveAttribute('data-query', 'Initial');
  expect(screen.getByTestId('filmcraft-panel')).toHaveAttribute('data-active', 'true');
  view.rerender(<WriterDesk {...initial} active={false} />);
  expect(screen.getByTestId('filmcraft-panel')).toHaveAttribute('data-active', 'false');
});

it("does not undo the screenplay from Develop or another workspace mode", async () => {
  render(<WriterDesk {...props()} />); await act(async () => {});
  const input = source();
  fireEvent.change(input, { target: { value: 'Keep this screenplay edit.' } });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Develop' }), { button: 0, ctrlKey: false });
  command('undo'); expect(input).toHaveValue('Keep this screenplay edit.');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Write' }), { button: 0, ctrlKey: false });
  command('undo'); expect(input).toHaveValue('Initial action.');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Film language' }), { button: 0, ctrlKey: false });
  command('redo'); expect(input).toHaveValue('Initial action.');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Write' }), { button: 0, ctrlKey: false });
  command('redo'); expect(input).toHaveValue('Keep this screenplay edit.');
});

it("retains development editing across tabs and requires a saved screenplay", async () => {
  const initial = props(); const view = render(<WriterDesk {...initial} />); await act(async () => {});
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Develop' }), { button: 0, ctrlKey: false });
  const input = screen.getByRole('textbox', { name: 'Development notes' });
  expect(input).toHaveAttribute('data-project', project.id);
  expect(input).toHaveAttribute('data-draft', record().id);
  fireEvent.change(input, { target: { value: 'Keep this beat.' } });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Preview' }), { button: 0, ctrlKey: false });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Develop' }), { button: 0, ctrlKey: false });
  expect(screen.getByRole('textbox', { name: 'Development notes' })).toHaveValue('Keep this beat.');
  view.unmount();
  render(<WriterDesk {...initial} open={{ id: 'screenplay-draft:new', saved: null, initial: record().data }} />);
  await act(async () => {});
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Develop' }), { button: 0, ctrlKey: false });
  expect(screen.getByText('Save this screenplay once to give its world and development notes a home on this Mac.')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Development notes' })).toBeNull();
});

it("removes an obsolete known disk copy after saving newer typing before the debounce", async () => {
  let disk: RecoveryCopy | null = null;
  vi.mocked(localApi.recovery.get).mockImplementation(async () => disk);
  vi.mocked(localApi.recovery.put).mockImplementation(async value => { disk = value; return value; });
  vi.mocked(localApi.recovery.remove).mockImplementation(async (_id, savedAt) => { const deleted = disk?.savedAt === savedAt; if (deleted) disk = null; return { deleted }; });
  const saved = record('New acknowledged body.', 2);
  vi.mocked(localApi.save).mockResolvedValue(saved);
  const view = render(<WriterDesk {...props()} />); await act(async () => {});
  const input = source(); fireEvent.change(input, { target: { value: 'Old template body.' } });
  await act(async () => (window as unknown as { __flushWriterRecovery: () => Promise<void> }).__flushWriterRecovery());
  const oldTimestamp = disk!.savedAt;
  fireEvent.change(input, { target: { value: saved.data.body } });
  await act(async () => window.dispatchEvent(new CustomEvent('writer:command', { detail: 'save' })));
  expect(localApi.recovery.remove).toHaveBeenCalledWith(saved.id, oldTimestamp);
  expect(disk).toBeNull();
  view.unmount(); render(<WriterDesk {...props(saved)} />); await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
});

it("flushes latest pending edits immediately and rejects an unconfirmed disk write", async () => {
  const view = render(<WriterDesk {...props()} />); await act(async () => {});
  const input = source(); fireEvent.change(input, { target: { value: 'Quit-time text.' } });
  const host = window as unknown as { __flushWriterRecovery?: () => Promise<void> };
  vi.mocked(localApi.recovery.put).mockRejectedValueOnce(new Error('Disk write failed'));
  await act(async () => { await expect(host.__flushWriterRecovery!()).rejects.toThrow('Disk write failed'); });
  await act(async () => host.__flushWriterRecovery!());
  expect(localApi.recovery.put).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: 'Quit-time text.' }) }));
  view.unmount(); expect(host.__flushWriterRecovery).toBeUndefined();
});

it("offers metadata-only recovery for a new draft and permits retrying a failed disk check", async () => {
  const metadata = { ...copy(''), baseVersion: null, baseSha256: null, data: buildDraftData(project.id, { title: 'Owner title', body: '', logline: 'Owner logline', genre: 'Drama' }) };
  vi.mocked(localApi.recovery.get).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(metadata);
  render(<WriterDesk {...props()} open={{ id: record().id, saved: null, initial: buildDraftData(project.id, { title: 'Untitled screenplay', body: '' }) }} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Retry recovery check' })); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Owner title');
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Revised title' } });
  await act(async () => (window as unknown as { __flushWriterRecovery: () => Promise<void> }).__flushWriterRecovery());
  expect(localApi.recovery.put).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: 'Revised title', logline: 'Owner logline', genre: 'Drama', body: '' }) }));
});

it("does not offer this mount's new short draft as recovery when the initial disk read returns null", async () => {
  const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const initial = buildDraftData(project.id, { title: 'Untitled screenplay', body: '', projectFormat: 'short' });
  render(<WriterDesk {...props()} open={{ id: draftId, saved: null, initial }} records={[]} />);
  await act(async () => {});

  expect(localApi.recovery.get).toHaveBeenCalledWith(draftId);
  // The browser backup made by this mount is current working state, not an
  // older recovery offer. The selected format still belongs in that backup.
  expect(JSON.parse(localStorage.getItem(recoveryKey(draftId))!).data).toEqual(initial);
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  expect(screen.queryByText(/Unsaved work from/)).toBeNull();

  const input = source();
  fireEvent.change(input, { target: { value: 'First new scene.' } });
  fireEvent.change(input, { target: { value: 'Latest new scene.' } });
  await waitFor(() => expect(localApi.recovery.put).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId, baseVersion: null, baseSha256: null,
    data: expect.objectContaining({ body: 'Latest new scene.', projectFormat: 'short' }),
  })), { timeout: 2000 });
  expect(input).toHaveValue('Latest new scene.');
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  expect(localApi.save).not.toHaveBeenCalled();
});

it("preserves typing before initial recovery resolves without offering this mount's browser copy", async () => {
  const draftId = 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const initial = buildDraftData(project.id, { title: 'Untitled screenplay', body: '', projectFormat: 'short' });
  let resolveRead!: (copy: RecoveryCopy | null) => void;
  vi.mocked(localApi.recovery.get).mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
  render(<WriterDesk {...props()} open={{ id: draftId, saved: null, initial }} records={[]} />);

  const input = source();
  fireEvent.change(input, { target: { value: 'Typing while the disk is being checked.' } });
  fireEvent.change(input, { target: { value: 'Newest typing before the read finishes.' } });
  expect(localApi.recovery.put).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(recoveryKey(draftId))!).data.body).toBe('Newest typing before the read finishes.');

  await act(async () => resolveRead(null));
  expect(input).toHaveValue('Newest typing before the read finishes.');
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  expect(screen.queryByText(/Unsaved work from/)).toBeNull();
  await waitFor(() => expect(localApi.recovery.put).toHaveBeenLastCalledWith(expect.objectContaining({
    draftId, baseVersion: null, baseSha256: null,
    data: expect.objectContaining({ body: 'Newest typing before the read finishes.', projectFormat: 'short' }),
  })), { timeout: 2000 });
  expect(localApi.save).not.toHaveBeenCalled();
});


it("uses the same story-word measure as the library and labels formatted pages", async () => {
  const body = "Title: Hidden title\nAuthor: Someone\n\n[[Private reference words stay excluded.]]\n\nINT. ROOM - DAY\n\n!A light flickers.\n\n@Mira (O.S.)\n(quietly)\nStay here.\n";
  const view = render(<WriterDesk {...props(record(body))} />);
  await act(async () => {});
  const measures = screen.getByLabelText("Screenplay measures");
  expect(measures).toHaveTextContent("1 formatted pp · 1 scene · 5 words");
  expect(within(measures).getByText("5 words")).toHaveAttribute("title", expect.stringContaining("Headings, character cues"));
  expect(view.container.querySelector('[aria-label="Title"]')).toHaveValue("Test");
});
