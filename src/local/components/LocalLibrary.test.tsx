import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildDraftData, TEMPLATES, type RecoveryCopy } from "../model";
import type { DraftRecord, ScreenplayDraftData } from "../types";
import { LocalLibrary, type LocalLibraryProps } from "./LocalLibrary";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function draft(title: string, fields: Partial<ScreenplayDraftData> = {}, version = 1): DraftRecord {
  return { id: `screenplay-draft:${title}`, kind: "screenplay-draft", version, sha256: `hash-${version}`, data: { ...buildDraftData("project:test", { title, body: "INT. ROOM - DAY\n\nSomeone waits here.\n\nEXT. ROAD - NIGHT\n\nA car leaves.", projectFormat: "short" }), ...fields } };
}
function recovery(saved: DraftRecord, fields: Partial<RecoveryCopy> = {}): RecoveryCopy {
  return { schema: "caniscreenwrite-local-writer-recovery/v1", draftId: saved.id, baseVersion: null, baseSha256: null, savedAt: "2026-09-26T12:00:00.000Z", data: saved.data, ...fields };
}
function props(extra: Partial<LocalLibraryProps> = {}): LocalLibraryProps {
  return { drafts: [], records: [], recoveries: [], onOpen: vi.fn(), onRecover: vi.fn(), onNew: vi.fn(), onImport: vi.fn(), view: "drafts", ...extra };
}
const search = (value: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Search drafts" }), { target: { value } });
const format = (value: string) => fireEvent.change(screen.getByRole("combobox", { name: "Format" }), { target: { value } });

it("shows real metadata in alphabetical order, opens the exact record, and works offline", () => {
  const offline = vi.fn(() => { throw new Error("Offline"); }); vi.stubGlobal("fetch", offline);
  const alpha = draft("Alpha", { logline: "A courier must choose a destination." }, 2);
  const zulu = draft("Zulu", { projectFormat: "feature" }, 19);
  const drafts = [zulu, alpha]; const original = JSON.stringify(drafts);
  const callbacks = props({ drafts });
  render(<LocalLibrary {...callbacks} />);
  const list = screen.getByRole("list", { name: "Saved screenplays" });
  expect(within(list).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Alpha", "Zulu"]);
  const row = within(list).getAllByRole("listitem").find((item) => within(item).queryByRole("heading", { name: "Alpha" }))!;
  expect(within(row).getByText(alpha.data.logline!)).toBeVisible();
  expect(within(row).getByText("Short film")).toBeVisible();
  expect(within(row).getByText("2 scenes")).toBeVisible();
  expect(within(row).getByText("6 words")).toBeVisible();
  expect(within(row).getByText("Revision 2")).toBeVisible();
  expect(screen.getByText("Title A–Z")).toBeVisible();
  expect(screen.queryByText(/last edited|minutes ago|recently edited/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  expect(callbacks.onOpen).toHaveBeenCalledExactlyOnceWith(alpha);
  expect(callbacks.onNew).not.toHaveBeenCalled();
  expect(callbacks.onRecover).not.toHaveBeenCalled();
  expect(offline).not.toHaveBeenCalled();
  expect(JSON.stringify(drafts)).toBe(original);
});

it("counts actual Fountain scenes and words without inventing a scene for notes or an empty draft", () => {
  const onlyNotes = draft("Notebook", { body: "Title: Notebook\nAuthor: Someone\n\n# ACT ONE\n\n[[Private note]]\n\n/* INT. HIDDEN - NIGHT\n\nDeleted scene. */" });
  const action = draft("Action", { body: "A quiet room." });
  render(<LocalLibrary {...props({ drafts: [onlyNotes, action] })} />);
  expect(screen.getAllByText("0 scenes")).toHaveLength(2);
  expect(screen.getByText("0 words")).toBeVisible();
  expect(screen.getByText("3 words")).toBeVisible();
});

it("combines case-insensitive title, logline and genre search with format filters", () => {
  const items = [draft("Harbor", { genre: "Mystery", logline: "A lighthouse goes dark." }), draft("Voyage", { projectFormat: "feature", genre: "Mystery" }), draft("Unsorted", { projectFormat: undefined })];
  render(<LocalLibrary {...props({ drafts: items })} />);
  search("  LIGHTHOUSE  ");
  expect(screen.getByRole("button", { name: "Open Harbor" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open Voyage" })).not.toBeInTheDocument();
  search("mystery"); format("feature");
  expect(screen.getByRole("button", { name: "Open Voyage" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open Harbor" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 saved draft matching your filters");
  search("harbor");
  expect(screen.getByRole("heading", { name: "No matching drafts" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(screen.getByRole("combobox")).toHaveValue("all");
  expect(screen.getByRole("status")).toHaveTextContent("3 saved drafts");
  format("unset");
  expect(screen.getByRole("button", { name: "Open Unsorted" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open Harbor" })).not.toBeInTheDocument();
});

it("keeps never-saved metadata-only recoveries accessible and chooses the newest copy without saving", () => {
  const original = recovery(draft("Unfinished", { body: "", logline: "An unfinished thought.", projectFormat: "micro" }));
  const latest = { ...original, savedAt: "2026-09-26T12:01:00.000Z", data: { ...original.data, logline: "The newest thought." } };
  const callbacks = props({ recoveries: [latest, original] });
  render(<LocalLibrary {...callbacks} />);
  expect(screen.queryByRole("heading", { name: "Create your first screenplay" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Recover Unfinished" })).toHaveLength(1);
  expect(screen.getByText("Never saved")).toBeVisible();
  expect(screen.getByText("The newest thought.")).toBeVisible();
  expect(screen.getByText("0 words")).toBeVisible();
  expect(callbacks.onRecover).not.toHaveBeenCalled();
  search("newest"); format("micro");
  fireEvent.click(screen.getByRole("button", { name: "Recover Unfinished" }));
  expect(callbacks.onRecover).toHaveBeenCalledExactlyOnceWith(latest);
  expect(callbacks.onOpen).not.toHaveBeenCalled();
  expect(callbacks.onNew).not.toHaveBeenCalled();
  format("feature");
  expect(screen.getByRole("heading", { name: "No matching drafts" })).toBeVisible();
});

it("offers changed saved-draft recovery explicitly, hides saved-equivalent copies, and keeps projects distinct", () => {
  const saved = draft("Saved", {}, 3);
  const identical = recovery(draft("Identical"));
  const changed = recovery(saved, { baseVersion: 3, baseSha256: saved.sha256, data: { ...saved.data, body: "An unsaved change." } });
  const otherProject = recovery(saved, { data: { ...saved.data, projectId: "project:other", title: "Other project" } });
  const callbacks = props({ drafts: [saved, draft("Identical")], recoveries: [identical, changed, otherProject] });
  render(<LocalLibrary {...callbacks} />);
  expect(screen.queryByRole("button", { name: "Recover unsaved work for Identical" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Recover Other project" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Saved" }));
  expect(callbacks.onOpen).toHaveBeenCalledExactlyOnceWith(saved);
  expect(callbacks.onRecover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Recover unsaved work for Saved" }));
  expect(callbacks.onRecover).toHaveBeenCalledExactlyOnceWith(changed);
});

it("uses workspace records to suppress acknowledged copies and updates when recoveries change", () => {
  const saved = draft("Acknowledged", {}, 4);
  const identical = recovery(saved);
  const callbacks = props({ records: [saved], recoveries: [identical] });
  const view = render(<LocalLibrary {...callbacks} />);
  expect(screen.queryByRole("button", { name: "Recover Acknowledged" })).not.toBeInTheDocument();
  const unsaved = { ...identical, data: { ...saved.data, body: "New edits." } };
  view.rerender(<LocalLibrary {...callbacks} recoveries={[unsaved]} />);
  expect(screen.getByRole("button", { name: "Recover Acknowledged" })).toBeVisible();
  expect(screen.getByText("Unsaved recovery copy")).toBeVisible();
  expect(screen.queryByText("Never saved")).not.toBeInTheDocument();
});

it("provides clear new and import actions with no sample drafts in an empty library", () => {
  const callbacks = props();
  render(<LocalLibrary {...callbacks} />);
  expect(screen.getByRole("heading", { name: "My Drafts" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Create your first screenplay" })).toBeVisible();
  expect(screen.getByText("Saved drafts and recovery copies on this Mac.")).toBeVisible();
  expect(screen.queryByRole("list", { name: "Saved screenplays" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Import screenplay" }));
  expect(callbacks.onNew).toHaveBeenCalledExactlyOnceWith("blank");
  expect(callbacks.onImport).toHaveBeenCalledExactlyOnceWith();
  expect(callbacks.onOpen).not.toHaveBeenCalled();
});

it("shows every bundled template with a description and passes its real id only on Use", () => {
  const callbacks = props({ view: "templates" });
  render(<LocalLibrary {...callbacks} />);
  expect(screen.getByRole("heading", { name: "Templates", level: 1 })).toBeVisible();
  const list = screen.getByRole("list", { name: "Screenplay templates" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(TEMPLATES.length);
  expect(callbacks.onNew).not.toHaveBeenCalled();
  for (const template of TEMPLATES) {
    const row = within(list).getByRole("heading", { name: template.label }).closest("li")!;
    expect(row.querySelector("p")?.textContent?.length).toBeGreaterThan(20);
    fireEvent.click(within(row).getByRole("button", { name: `Use ${template.label} template` }));
    expect(callbacks.onNew).toHaveBeenLastCalledWith(template.id);
  }
  expect(callbacks.onNew).toHaveBeenCalledTimes(TEMPLATES.length);
  expect(callbacks.onImport).not.toHaveBeenCalled();
  expect(callbacks.onOpen).not.toHaveBeenCalled();
});
