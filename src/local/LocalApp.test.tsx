import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LocalApp from "./LocalApp";
import { localApi } from "./api";
import { buildDraftData } from "./model";
import type { DraftRecord } from "./types";

const probes = vi.hoisted(() => ({ flush: vi.fn(), mounts: vi.fn(), online: vi.fn() }));
vi.mock("./api", () => ({ SESSION_LOST_EVENT: "local-writer:session-lost", LocalApiError: class extends Error {}, localApi: { health: vi.fn(), bootstrap: vi.fn(), logout: vi.fn(), recovery: { list: vi.fn() } } }));
vi.mock("./components/WriterDesk", async () => {
  const { useEffect, useState } = await import("react");
  return { WriterDesk: ({ open, active }: { open: { id: string; saved: DraftRecord | null; initial: DraftRecord["data"] | null }; active: boolean }) => {
    const [body, setBody] = useState(open.saved?.data.body ?? open.initial?.body ?? "");
    useEffect(() => {
      probes.mounts(open.id);
      const host = window as Window & { __flushWriterRecovery?: () => Promise<void> };
      host.__flushWriterRecovery = probes.flush;
      return () => { delete host.__flushWriterRecovery; };
    }, [open.id]);
    return <section aria-label="Open screenplay"><p>{open.saved?.data.title ?? open.initial?.title}</p><textarea aria-label="Working screenplay" value={body} onChange={event => setBody(event.target.value)} /><span>{active ? "Active editor" : "Suspended editor"}</span></section>;
  } };
});
vi.mock("./components/LocalLibrary", () => ({ LocalLibrary: ({ drafts, onOpen, view }: { drafts: DraftRecord[]; onOpen: (draft: DraftRecord) => void; view: string }) => <section aria-label="Library"><h1>{view === "templates" ? "Templates" : "My drafts"}</h1>{drafts.map(draft => <button key={draft.id} onClick={() => onOpen(draft)}>{draft.data.title}</button>)}</section> }));
vi.mock("./components/FilmcraftPanel", () => ({ FilmcraftPanel: () => <p>Offline film reference</p> }));
vi.mock("./components/QiMoviPanel", () => ({ QiMoviPanel: () => <p>Local production connection</p> }));
vi.mock("./components/CompetitionPanel", () => { probes.online(); return { CompetitionPanel: () => <p>Online competition connection</p> }; });
vi.mock('./components/PreservationPanel', () => ({ PreservationPanel: ({ onBack, onConnections }: { onBack: () => void; onConnections: () => void }) => <section aria-label="Preservation"><button onClick={onBack}>Back to writing</button><button onClick={onConnections}>Open QiMovi connection</button></section> }));
vi.mock('./components/RightsPanel', async () => {
  const { useState } = await import('react');
  return { RightsPanel: ({ active }: { active: boolean }) => {
    const [note, setNote] = useState('');
    return <section hidden={!active} aria-label="Rights workspace"><input aria-label="Working rights" value={note} onChange={event => setNote(event.target.value)} /></section>;
  } };
});

const draft = (id: string, title: string): DraftRecord => ({ id: `screenplay-draft:${id}`, kind: "screenplay-draft", version: 1, sha256: "a".repeat(64), data: buildDraftData("project:test", { title, body: `${title} action.` }) });
beforeEach(() => {
  vi.clearAllMocks(); probes.flush.mockResolvedValue(undefined);
  vi.mocked(localApi.health).mockResolvedValue({} as never);
  vi.mocked(localApi.bootstrap).mockResolvedValue({ project: { id: "project:test", title: "My screenplays", profile: "caniscreenwrite-local-writer/v1", sourceHash: null, sourceStatus: "NO_SOURCE" }, records: [draft("one", "First film"), draft("two", "Second film")], connectors: { qimovi: { configured: false, connected: false, origin: null, project: null } } });
  vi.mocked(localApi.recovery.list).mockResolvedValue([]);
});
afterEach(() => cleanup());
async function ready() { render(<LocalApp />); await screen.findByRole("heading", { name: "My drafts" }); }
async function openFirst() { await ready(); fireEvent.click(screen.getByRole("button", { name: "First film" })); return await screen.findByRole("textbox", { name: "Working screenplay" }); }

it("opens the draft library without constructing an editor or online connection", async () => {
  await ready();
  expect(probes.mounts).not.toHaveBeenCalled(); expect(probes.online).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Knowledge" })).toBeVisible();
});

it("keeps working text and the same editor mounted while browsing studio views", async () => {
  const input = await openFirst();
  fireEvent.change(input, { target: { value: "An unsaved new scene." } });
  fireEvent.click(screen.getByRole("button", { name: "My drafts" }));
  await waitFor(() => expect(probes.flush).toHaveBeenCalled());
  expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
  expect(screen.getByText("Offline film reference")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(input).toBeVisible(); expect(input).toHaveValue("An unsaved new scene.");
  expect(probes.mounts).toHaveBeenCalledTimes(1);
});

it("opens an already-open library draft without resetting its unsaved text", async () => {
  const input = await openFirst();
  fireEvent.change(input, { target: { value: "Keep this paragraph." } });
  fireEvent.click(screen.getByRole("button", { name: "My drafts" }));
  fireEvent.click(screen.getByRole("button", { name: "First film" }));
  expect(input).toHaveValue("Keep this paragraph."); expect(probes.mounts).toHaveBeenCalledTimes(1);
});

it("opens preservation from the native menu without losing working text, then reaches QiMovi", async () => {
  const input = await openFirst();
  fireEvent.change(input, { target: { value: "A new unsaved world scene." } });
  await act(async () => { window.dispatchEvent(new CustomEvent('writer:command', { detail: 'preservation' })); });
  expect(await screen.findByRole('region', { name: 'Preservation' })).toBeVisible();
  expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Back to writing' }));
  expect(input).toBeVisible();
  expect(input).toHaveValue('A new unsaved world scene.');
  await act(async () => { window.dispatchEvent(new CustomEvent('writer:command', { detail: 'preservation' })); });
  fireEvent.click(await screen.findByRole('button', { name: 'Open QiMovi connection' }));
  expect(screen.getByText('Local production connection')).toBeVisible();
  expect(probes.mounts).toHaveBeenCalledTimes(1);
});

it('opens rights from the native menu and preserves edits across studio navigation', async () => {
  const screenplay = await openFirst();
  fireEvent.change(screenplay, { target: { value: 'Retain screenplay editing.' } });
  await act(async () => { window.dispatchEvent(new CustomEvent('writer:command', { detail: 'rights' })); });
  const rights = await screen.findByRole('textbox', { name: 'Working rights' });
  fireEvent.change(rights, { target: { value: 'Retain rights editing.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }));
  expect(rights).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Rights' }));
  expect(rights).toHaveValue('Retain rights editing.');
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(screenplay).toHaveValue('Retain screenplay editing.');
  expect(probes.mounts).toHaveBeenCalledTimes(1);
});

it("does not replace an open screenplay if durable recovery fails", async () => {
  const input = await openFirst();
  fireEvent.change(input, { target: { value: "Keep the only copy." } });
  probes.flush.mockRejectedValue(new Error("Disk unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "My drafts" }));
  fireEvent.click(screen.getByRole("button", { name: "Second film" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(input).toHaveValue("Keep the only copy."); expect(probes.mounts).toHaveBeenCalledTimes(1);
});

it("creates a blank draft from the main studio action", async () => {
  await ready(); fireEvent.click(screen.getByRole("button", { name: "New draft" }));
  expect(await screen.findByRole("textbox", { name: "Working screenplay" })).toHaveValue("");
  expect(screen.getByText("Untitled screenplay")).toBeVisible();
});

it("makes connections available before creating a draft and loads online code only on request", async () => {
  await ready(); fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  expect(screen.getByText("Local production connection")).toBeVisible();
  expect(probes.online).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Enable online competition" }));
  expect(await screen.findByText("Online competition connection")).toBeVisible();
  expect(probes.mounts).not.toHaveBeenCalled();
});
