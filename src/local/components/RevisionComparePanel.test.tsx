import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryPanel } from './HistoryPanel';
import { RevisionComparePanel, RevisionTextDiffView } from './RevisionComparePanel';
import { compareRevisionText, DIFF_LINE_PREVIEW, DIFF_PAGE_SIZE, revisionKey, SCENE_PAGE_SIZE } from '../revision-compare';
import { localApi } from '../api';
import type { DraftRecord } from '../types';

vi.mock('../api', () => ({ localApi: { history: vi.fn() } }));
const record = (version: number, body = `Saved text ${version}`, id = 'screenplay-draft:compare'): DraftRecord => ({ id, kind: 'screenplay-draft', version, sha256: String(version).padStart(64, 'a'), data: { schemaVersion: 2, projectId: 'project:compare', sourceHash: null, title: `Title ${version}`, format: 'FOUNTAIN', body, status: 'DRAFT' } });
const revisions = () => [record(1), record(2), record(3)];
const props = (saved = record(3)) => ({ draftId: saved.id, saved, currentBody: 'Unsaved working text', onRestore: vi.fn(), onSelectBaseline: vi.fn() });
const choose = (label: 'From revision' | 'To revision', value: DraftRecord) => fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value: revisionKey(value) } });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(localApi.history).mockResolvedValue(revisions()); });
afterEach(cleanup);

it('chooses two explicit saved revisions, shows full record identities and swaps direction', () => {
  const rows = revisions(); render(<RevisionComparePanel revisions={[rows[2], rows[0], rows[1]]} />);
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(rows[1]));
  expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveValue(revisionKey(rows[2]));
  choose('From revision', rows[0]); choose('To revision', rows[1]);
  expect(screen.getByLabelText('From stored SHA-256')).toHaveTextContent(rows[0].sha256);
  expect(screen.getByLabelText('To stored SHA-256')).toHaveTextContent(rows[1].sha256);
  expect(screen.getByRole('region', { name: 'From saved identity' })).toHaveTextContent(`Record ${rows[0].id}`);
  expect(screen.getByRole('region', { name: 'Text differences' })).toHaveTextContent('Saved text 1');
  expect(screen.getByRole('region', { name: 'Text differences' })).toHaveTextContent('Saved text 2');
  expect(within(screen.getByRole('combobox', { name: 'To revision' })).getByRole('option', { name: 'v1 · Title 1' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Swap revisions' }));
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(rows[1]));
  expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveValue(revisionKey(rows[0]));
});

it('shows metadata changes even when saved bodies are identical', () => {
  const before = record(1, 'Same'), after = record(2, 'Same');
  before.data = { ...before.data, genre: 'Drama', logline: 'Old logline', projectFormat: 'short' };
  after.data = { ...after.data, genre: 'Mystery', logline: 'New logline', projectFormat: 'feature' };
  render(<RevisionComparePanel revisions={[before, after]} />);
  const metadata = screen.getByRole('region', { name: 'Metadata differences' });
  for (const value of ['Title 1', 'Title 2', 'Drama', 'Mystery', 'Old logline', 'New logline', 'short', 'feature']) expect(metadata).toHaveTextContent(value);
  expect(metadata.querySelectorAll('[data-changed="true"]')).toHaveLength(4);
  expect(screen.getByText('Saved body text is identical.')).toBeVisible();
  expect(screen.getByText('1 unchanged line hidden')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show unchanged lines' }));
  expect(screen.getByRole('region', { name: 'Text differences' })).toHaveTextContent('Same');
});

it('keeps an explicit pair selected when a new saved revision arrives', () => {
  const rows = revisions(); const view = render(<RevisionComparePanel revisions={rows} />);
  choose('From revision', rows[0]); choose('To revision', rows[1]);
  view.rerender(<RevisionComparePanel revisions={[...rows, record(4)]} />);
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(rows[0]));
  expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveValue(revisionKey(rows[1]));
});

it('requires two versions and handles empty bodies and cross-draft records honestly', () => {
  const view = render(<RevisionComparePanel revisions={[record(1)]} />);
  expect(screen.getByText(/Save at least two revisions/)).toBeVisible();
  expect(screen.queryByRole('combobox')).toBeNull();
  view.rerender(<RevisionComparePanel revisions={[record(1, ''), record(2, '')]} />);
  expect(screen.getByText('Both bodies are empty.')).toBeVisible();
  view.rerender(<RevisionComparePanel revisions={[record(1), record(2, '', 'screenplay-draft:other')]} />);
  expect(screen.getByRole('alert')).toHaveTextContent('same draft');
});

it('reports scene ambiguity and reordering without false changed-scene claims', () => {
  const repeated = 'INT. ROOM - DAY\n\nOne.\n\nINT. ROOM - DAY\n\nTwo.';
  const view = render(<RevisionComparePanel revisions={[record(1, repeated), record(2, repeated.replace('Two.', 'Edit.'))]} />);
  expect(screen.getByRole('region', { name: 'Scene differences' })).toHaveTextContent('0 added · 0 removed · 0 changed');
  expect(screen.getByText(/Identity unresolved: 2 From scenes and 2 To scenes/)).toBeVisible();
  const a = 'INT. ROOM - DAY\n\nOne.', b = 'EXT. ROAD - DAY\n\nTwo.';
  view.rerender(<RevisionComparePanel revisions={[record(1, `${a}\n\n${b}`), record(2, `${b}\n\n${a}`)]} />);
  expect(screen.getByText('Matched scene order changed.')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Scene differences' })).toHaveTextContent('0 changed · 2 unchanged matches');
});

it('bounds DOM rows for maximum bodies, pages to later changes and resets on a new pair', () => {
  const a = record(1, 'a\n'.repeat(100_000)), b = record(2, 'b\n'.repeat(100_000));
  const view = render(<RevisionComparePanel revisions={[a, b, record(3, 'Small')]} />);
  choose('From revision', a); choose('To revision', b);
  expect(view.container.querySelectorAll('.lw-compare-line')).toHaveLength(DIFF_PAGE_SIZE);
  expect(screen.getByText(/Large changed region:/)).toBeVisible();
  expect(screen.getByText(/Scene summary is limited/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next text page' }));
  expect(screen.getByText('Page 2 of 2500')).toBeVisible();
  expect(view.container.querySelector('.lw-compare-line-number')).toHaveTextContent('81 / –');
  choose('To revision', record(3, 'Small'));
  expect(screen.getByRole('button', { name: 'Previous text page' })).toBeDisabled();
  expect(view.container.querySelectorAll('.lw-compare-line').length).toBeLessThanOrEqual(DIFF_PAGE_SIZE);
}, 10_000);

it('clips huge physical lines and preserves visible line-ending-only changes', () => {
  const view = render(<RevisionTextDiffView diff={compareRevisionText('a'.repeat(200_000), 'b'.repeat(200_000))} />);
  expect(view.container.querySelectorAll('.lw-compare-line')).toHaveLength(2);
  expect(view.container.textContent!.length).toBeLessThan(DIFF_LINE_PREVIEW * 2 + 1500);
  expect(screen.getAllByText(/198,800 characters omitted/)).toHaveLength(2);
  view.rerender(<RevisionTextDiffView diff={compareRevisionText('same\r\n', 'same\n')} />);
  expect(screen.getByText('⟪CRLF⟫')).toBeVisible(); expect(screen.getByText('⟪LF⟫')).toBeVisible();
});

it('paginates unchanged lines and scene summaries instead of growing the DOM', () => {
  const body = Array.from({ length: 100 }, (_, index) => `INT. ROOM ${index} - DAY\n\nAction.`).join('\n\n');
  const view = render(<RevisionComparePanel revisions={[record(1, ''), record(2, body)]} />);
  expect(view.container.querySelectorAll('.lw-compare-scenes li')).toHaveLength(SCENE_PAGE_SIZE);
  fireEvent.click(screen.getByRole('button', { name: 'Next scenes page' }));
  expect(view.container.querySelector('.lw-compare-scenes')).toHaveTextContent('INT. ROOM 40 - DAY');
  view.rerender(<RevisionTextDiffView diff={compareRevisionText('\n'.repeat(200_000), '\n'.repeat(200_000))} />);
  expect(screen.getByText('200,000 unchanged lines hidden')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show unchanged lines' }));
  expect(view.container.querySelectorAll('.lw-compare-line')).toHaveLength(DIFF_PAGE_SIZE);
});

it('History excludes working text, preserves saved pair selection, and only restores or selects a baseline on explicit clicks', async () => {
  const initial = props(); const snapshot = JSON.stringify(revisions());
  const view = render(<HistoryPanel {...initial} />);
  await screen.findByRole('combobox', { name: 'From revision' });
  choose('From revision', record(1));
  expect(screen.queryByText(/Unsaved working text/)).toBeNull();
  expect(initial.onRestore).not.toHaveBeenCalled(); expect(initial.onSelectBaseline).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use v1 as revision-mark baseline' }));
  expect(initial.onSelectBaseline).toHaveBeenCalledWith(record(1));
  fireEvent.click(screen.getByRole('button', { name: 'Compare with editor / restore' }));
  fireEvent.click(within(screen.getByRole('list', { name: 'Revisions' })).getByRole('button', { name: /v1 · Title 1/ }));
  expect(screen.getByRole('region', { name: 'Text differences' })).toHaveTextContent('Unsaved working text');
  fireEvent.click(screen.getByRole('button', { name: 'Restore v1 into editor' }));
  expect(initial.onRestore).toHaveBeenCalledExactlyOnceWith('Saved text 1');
  view.rerender(<HistoryPanel {...initial} currentBody="Saved text 1" />);
  expect(screen.getByRole('button', { name: 'Restore v1 into editor' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Saved revisions' }));
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(record(1)));
  expect(JSON.stringify(revisions())).toBe(snapshot);
  expect(localApi.history).toHaveBeenCalledTimes(1);
});

it('retains independent hidden draft selection without touching either working text', async () => {
  const first = props(), second = props(record(3, 'Other saved', 'screenplay-draft:other'));
  vi.mocked(localApi.history).mockImplementation(async id => [record(1, 'Saved one', id), record(2, 'Saved two', id), record(3, 'Saved three', id)]);
  function Harness({ other }: { other: boolean }) { return <><div hidden={other}><HistoryPanel {...first} /></div><div hidden={!other}><HistoryPanel {...second} /></div></>; }
  const view = render(<Harness other={false} />);
  await screen.findByRole('combobox', { name: 'From revision' });
  choose('From revision', record(1));
  view.rerender(<Harness other />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'From saved identity' })).toHaveTextContent('screenplay-draft:other'));
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(record(2, '', second.draftId)));
  view.rerender(<Harness other={false} />);
  expect(screen.getByRole('combobox', { name: 'From revision' })).toHaveValue(revisionKey(record(1)));
  expect(first.onRestore).not.toHaveBeenCalled(); expect(second.onRestore).not.toHaveBeenCalled();
});

it('discards late history responses after switching drafts', async () => {
  let resolve!: (records: DraftRecord[]) => void;
  vi.mocked(localApi.history).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const view = render(<HistoryPanel {...props()} />);
  const other = record(2, 'Other', 'screenplay-draft:other');
  vi.mocked(localApi.history).mockResolvedValue([record(1, 'Old other', other.id), other]);
  view.rerender(<HistoryPanel {...props(other)} />);
  await screen.findByRole('combobox', { name: 'From revision' });
  await act(async () => resolve(revisions()));
  expect(screen.getByRole('region', { name: 'From saved identity' })).toHaveTextContent(other.id);
  expect(screen.queryByText('Saved text 1')).toBeNull();
});

it('recovers from history errors and does not request history for unsaved drafts', async () => {
  const initial = props(); const view = render(<HistoryPanel {...initial} saved={null} />);
  expect(screen.getByText(/Save the draft to start/)).toBeVisible(); expect(localApi.history).not.toHaveBeenCalled();
  vi.mocked(localApi.history).mockRejectedValueOnce(new Error('Temporary local failure'));
  view.rerender(<HistoryPanel {...initial} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Temporary local failure');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  await screen.findByRole('combobox', { name: 'From revision' });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps saved selections when history refreshes and bounds the existing editor comparison', async () => {
  const initial = props(record(2, 'a\n'.repeat(100_000)));
  vi.mocked(localApi.history).mockResolvedValue([record(1), initial.saved]);
  const view = render(<HistoryPanel {...initial} currentBody={'b\n'.repeat(100_000)} />);
  await screen.findByRole('combobox', { name: 'From revision' });
  vi.mocked(localApi.history).mockResolvedValue([record(1), initial.saved, record(3)]);
  view.rerender(<HistoryPanel {...initial} saved={record(3)} currentBody={'b\n'.repeat(100_000)} />);
  await waitFor(() => expect(localApi.history).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('combobox', { name: 'To revision' })).toHaveValue(revisionKey(initial.saved));
  fireEvent.click(screen.getByRole('button', { name: 'Compare with editor / restore' }));
  const text = screen.getByRole('region', { name: 'Text differences' });
  expect(text).toHaveTextContent('Large changed region:');
  expect(text.querySelectorAll('.lw-compare-line')).toHaveLength(DIFF_PAGE_SIZE);
  fireEvent.click(screen.getByRole('button', { name: 'Restore v2 into editor' }));
  expect(initial.onRestore).toHaveBeenCalledWith(initial.saved.data.body);
}, 10_000);
