import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localApi, LocalApiError } from '../api';
import { createSharedWorld, type SharedWorldRecord } from '../shared-world';
import { createWorld, newWorldElement, newWorldLink } from '../world';
import type { Bootstrap } from '../types';
import { SharedWorldLibrary, type SharedWorldLibraryHandle } from './SharedWorldLibrary';

const projectId = 'local-project:shared-ui';
const id = 'shared-world:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record = (): SharedWorldRecord => ({ id, kind: 'shared-world', version: 1, sha256: 'a'.repeat(64), data: { ...createSharedWorld(projectId), name: 'Harbor stories', description: 'Saved overview.', world: { schemaVersion: 1, elements: [{ ...newWorldElement('location'), name: 'Harbor', description: 'Saved location.' }], links: [] } } });
const bootstrap = (records: SharedWorldRecord[]): Bootstrap => ({ project: { id: projectId, title: 'QA', profile: 'caniscreenwrite-local-writer/v1', sourceHash: null, sourceStatus: 'NO_SOURCE' }, records, connectors: { qimovi: { configured: false, origin: null, connected: false, project: null } } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const write = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
const world = () => {
  const a = { ...newWorldElement('location'), name: 'Archive', description: 'Owner description.' };
  const b = { ...newWorldElement('prop'), name: 'Key', continuity: 'Owner continuity.', order: 1 };
  return { schemaVersion: 1 as const, elements: [a, b], links: [newWorldLink(a.id, 'element', b.id, 'Key'), { ...newWorldLink(a.id, 'scene', 'number:1', 'INT. ARCHIVE - DAY'), notes: 'Only this draft.' }] };
};
async function setup(records: SharedWorldRecord[] = [], current = world()) {
  vi.spyOn(localApi, 'bootstrap').mockResolvedValue(bootstrap(records));
  vi.spyOn(localApi, 'save').mockImplementation(async input => ({ id: input.id, kind: input.kind, data: structuredClone(input.data), version: (input.expectedVersion ?? 0) + 1, sha256: 'b'.repeat(64) }));
  const ref = createRef<SharedWorldLibraryHandle>();
  const props = { projectId, world: current, notes: '  Complete owner overview.\n', onImport: vi.fn(() => null), onEditDraft: vi.fn() };
  const view = render(<SharedWorldLibrary ref={ref} {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'New shared world' })).toBeEnabled());
  return { ...view, ref, props };
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared world library snapshot workflow', () => {
  it('publishes only after count preview and keeps source links and full notes in the draft', async () => {
    const view = await setup();
    write('Shared world name', 'Archive stories'); click('Preview publication as new world');
    expect(screen.getByRole('region', { name: 'World copy preview' })).toHaveTextContent('2 elements, 1 internal connection');
    expect(screen.getByText(/1 scene or screenplay-character connection excluded/)).toBeInTheDocument();
    expect(localApi.save).not.toHaveBeenCalled(); click('Publish snapshot');
    await waitFor(() => expect(screen.getByText(/Published “Archive stories” v1/)).toBeInTheDocument());
    expect(localApi.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localApi.save).mock.calls[0][0]).toMatchObject({ kind: 'shared-world', expectedVersion: null, data: { name: 'Archive stories', description: view.props.notes, world: { elements: view.props.world.elements, links: [view.props.world.links[0]] } } });
    expect(view.props.world.links).toHaveLength(2); expect(view.props.onImport).not.toHaveBeenCalled();
  });
  it('creates an empty named world without importing draft content', async () => {
    await setup(); write('Shared world name', 'A new setting'); click('Preview empty world');
    expect(screen.getByRole('region', { name: 'World copy preview' })).toHaveTextContent('0 elements, 0 internal connections and 0 overview characters');
    click('Publish snapshot');
    await waitFor(() => expect(localApi.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(localApi.save).mock.calls[0][0].data).toEqual({ schemaVersion: 1, projectId, name: 'A new setting', description: '', world: createWorld() });
  });
  it('searches saved worlds, previews an additive import, and never saves a draft or mutates a library record', async () => {
    const saved = record(), before = structuredClone(saved);
    const view = await setup([saved]);
    write('Search shared worlds', 'missing'); expect(screen.getByText(/No shared worlds match/)).toBeInTheDocument();
    write('Search shared worlds', 'Harbor'); click(/Harbor stories v1/); click('Preview adding to draft');
    expect(view.props.onImport).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'World copy preview' })).toHaveTextContent('Result: 3 elements, 2 connections');
    click('Add snapshot to draft');
    expect(view.props.onImport).toHaveBeenCalledTimes(1);
    const [copied, notes] = view.props.onImport.mock.calls[0] as unknown as [typeof view.props.world, string];
    expect(copied.elements.slice(0, 2)).toEqual(view.props.world.elements);
    expect(copied.elements[2].id).not.toBe(saved.data.world.elements[0].id);
    expect(copied.links).toEqual(view.props.world.links);
    expect(notes).toContain('From shared world: Harbor stories (v1)\n\nSaved overview.');
    expect(saved).toEqual(before); expect(localApi.save).not.toHaveBeenCalled();
  });
  it('invalidates either preview when its draft input has changed', async () => {
    const view = await setup([record()]); click(/Harbor stories v1/); click('Preview adding to draft');
    view.rerender(<SharedWorldLibrary ref={view.ref} {...view.props} notes="Newer draft overview" />);
    click('Add snapshot to draft'); expect(view.props.onImport).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('changed after this preview');
    click('Preview revision of selected world');
    view.rerender(<SharedWorldLibrary ref={view.ref} {...view.props} notes="Yet newer draft overview" />);
    click('Publish snapshot'); expect(localApi.save).not.toHaveBeenCalled();
  });
  it('keeps an uncertain save exact and blocks close until the same request is confirmed', async () => {
    const view = await setup();
    vi.mocked(localApi.save).mockRejectedValueOnce(new LocalApiError('Lost response', 0, 'SERVICE_UNREACHABLE'));
    write('Shared world name', 'Archive stories'); click('Preview publication as new world'); click('Publish snapshot');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry publication' })).toBeInTheDocument());
    const first = structuredClone(vi.mocked(localApi.save).mock.calls[0][0]);
    expect(() => view.ref.current?.assertSaved()).toThrow('retry');
    expect(screen.getByRole('button', { name: 'Refresh library' })).toBeDisabled();
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload); expect(beforeUnload.defaultPrevented).toBe(true);
    click('Retry publication');
    await waitFor(() => expect(screen.getByText(/Published “Archive stories” v1/)).toBeInTheDocument());
    expect(vi.mocked(localApi.save).mock.calls[1][0]).toEqual(first);
    expect(() => view.ref.current?.assertSaved()).not.toThrow();
  });
  it('requires refresh and a new replacement preview after a version conflict', async () => {
    const saved = record(); await setup([saved]);
    vi.mocked(localApi.save).mockRejectedValueOnce(new LocalApiError('Changed', 409, 'VERSION_CONFLICT'));
    click(/Harbor stories v1/); click('Preview revision of selected world');
    expect(screen.getByRole('region', { name: 'World copy preview' })).toHaveTextContent('replaces all 1 element and 0 connections in library v1');
    click('Publish snapshot');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere'));
    expect(screen.getByRole('button', { name: 'Preview revision of selected world' })).toBeDisabled();
    vi.mocked(localApi.bootstrap).mockResolvedValueOnce(bootstrap([{ ...saved, version: 2, sha256: 'c'.repeat(64), data: { ...saved.data, description: 'A newer saved overview.' } }]));
    click('Refresh library');
    await waitFor(() => expect(screen.getByText('Saved v2')).toBeInTheDocument());
    click('Preview revision of selected world'); click('Publish snapshot');
    await waitFor(() => expect(screen.getByText(/Published “Harbor stories” v3/)).toBeInTheDocument());
    expect(vi.mocked(localApi.save).mock.calls[1][0].expectedVersion).toBe(2);
    expect(vi.mocked(localApi.save).mock.calls[1][0].requestId).not.toBe(vi.mocked(localApi.save).mock.calls[0][0].requestId);
  });
  it('retains its source if DevelopmentData rejects an oversized combined import', async () => {
    const view = await setup([record()]);
    view.props.onImport.mockReturnValueOnce('Combined development is too large.' as never);
    click(/Harbor stories v1/); click('Preview adding to draft'); click('Add snapshot to draft');
    expect(screen.getByRole('alert')).toHaveTextContent('Combined development is too large');
    expect(screen.getByRole('region', { name: 'World copy preview' })).toBeInTheDocument();
    expect(localApi.save).not.toHaveBeenCalled();
  });
  it('retains draft changes during a publication and confirms only the clicked snapshot', async () => {
    const view = await setup();
    let finish!: (value: SharedWorldRecord) => void;
    vi.mocked(localApi.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    write('Shared world name', 'Archive stories'); click('Preview publication as new world'); click('Publish snapshot');
    const request = vi.mocked(localApi.save).mock.calls[0][0];
    view.rerender(<SharedWorldLibrary ref={view.ref} {...view.props} notes="Newer notes while saving" />);
    await act(async () => finish({ id: request.id, kind: request.kind, version: 1, sha256: 'c'.repeat(64), data: request.data as SharedWorldRecord['data'] }));
    expect(screen.getByText(/Published “Archive stories” v1/)).toBeInTheDocument();
    expect(view.props.onImport).not.toHaveBeenCalled();
    expect(request.data).toMatchObject({ description: view.props.notes });
  });
});
