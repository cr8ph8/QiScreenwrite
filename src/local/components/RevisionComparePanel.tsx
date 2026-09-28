import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { compareSavedRevisions, diffDisplayRows, revisionKey, DIFF_LINE_PREVIEW, DIFF_PAGE_SIZE, SCENE_PAGE_SIZE, type RevisionTextDiff, type RevisionScenes } from '../revision-compare';
import type { DraftRecord } from '../types';
import './RevisionComparePanel.css';

interface Props { revisions: DraftRecord[]; onSelectBaseline?: (record: DraftRecord) => void }

function Pages({ page, pages, onPage, label }: { page: number; pages: number; onPage: (page: number) => void; label: string }) {
  if (pages <= 1) return null;
  return <nav className="lw-compare-pages" aria-label={`${label} pages`}>
    <Button size="sm" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={`Previous ${label.toLowerCase()} page`}>Previous</Button>
    <span>Page {page + 1} of {pages}</span>
    <Button size="sm" variant="outline" disabled={page === pages - 1} onClick={() => onPage(page + 1)} aria-label={`Next ${label.toLowerCase()} page`}>Next</Button>
  </nav>;
}

/** Rendering stays bounded for both many short lines and a single huge line. */
export function RevisionTextDiffView({ diff }: { diff: RevisionTextDiff }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [requestedPage, setPage] = useState(0);
  const rows = useMemo(() => diffDisplayRows(diff, showUnchanged), [diff, showUnchanged]);
  const pages = Math.max(1, Math.ceil(rows.length / DIFF_PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  return <section className="lw-compare-text" aria-label="Text differences">
    <div className="lw-compare-section-heading"><h3>Text</h3><label className="lw-compare-toggle"><input type="checkbox" checked={showUnchanged} onChange={event => { setShowUnchanged(event.target.checked); setPage(0); }} />Show unchanged lines</label></div>
    <p className="lw-compare-note">{diff.identical ? 'Saved body text is identical.' : `${diff.added.toLocaleString()} added lines · ${diff.removed.toLocaleString()} removed lines · ${diff.unchanged.toLocaleString()} unchanged lines`}</p>
    {diff.coarse && <p className="lw-compare-notice">Large changed region: shown as removed and added blocks to keep comparison responsive. Counts include any matching lines inside those blocks.</p>}
    <p className="lw-compare-note">From / To line numbers. Line endings are shown on changed lines; “end” means no final newline. Long lines show their first {DIFF_LINE_PREVIEW.toLocaleString()} characters.</p>
    <div className="lw-compare-lines">
      {rows.slice(page * DIFF_PAGE_SIZE, (page + 1) * DIFF_PAGE_SIZE).map((row, index) => {
        if (row.kind === 'unchanged') return <div className="lw-compare-unchanged" key={page * DIFF_PAGE_SIZE + index}>{row.count.toLocaleString()} unchanged {row.count === 1 ? 'line' : 'lines'} hidden</div>;
        const line = row.line;
        const ending = line.text.endsWith('\r\n') ? 'CRLF' : line.text.endsWith('\r') ? 'CR' : line.text.endsWith('\n') ? 'LF' : 'end';
        const text = line.text.replace(/(?:\r\n|\r|\n)$/, '');
        const omitted = Math.max(0, text.length - DIFF_LINE_PREVIEW);
        return <div className={`lw-compare-line lw-compare-line-${line.type}`} key={page * DIFF_PAGE_SIZE + index}>
          <span className="lw-compare-line-number" aria-label={`From line ${line.beforeLine ?? 'none'}, to line ${line.afterLine ?? 'none'}`}>{line.beforeLine ?? '–'} / {line.afterLine ?? '–'}</span>
          <span aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
          <span className="lw-compare-line-content">{text.slice(0, DIFF_LINE_PREVIEW).replace(/\uFEFF/g, '⟪BOM⟫') || ' '}{omitted > 0 && <span className="lw-compare-clipped"> … {omitted.toLocaleString()} characters omitted</span>}{line.type !== 'equal' && <small className="lw-compare-ending">⟪{ending}⟫</small>}</span>
        </div>;
      })}
      {!rows.length && <p className="lw-compare-unchanged">Both bodies are empty.</p>}
    </div>
    <Pages page={page} pages={pages} onPage={setPage} label="Text" />
  </section>;
}

function SceneSummary({ scenes }: { scenes: RevisionScenes }) {
  const [requestedPage, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(scenes.differences.length / SCENE_PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  if (scenes.status === 'limited') return <section aria-label="Scene differences"><h3>Scenes</h3><p className="lw-compare-notice">Scene summary is limited for this source size or paragraph shape. Use the text comparison; no scene identities have been assigned.</p></section>;
  const count = (type: 'added' | 'removed' | 'changed') => scenes.differences.filter(scene => scene.type === type).length;
  return <section aria-label="Scene differences">
    <h3>Scenes</h3>
    <p className="lw-compare-note">{scenes.beforeCount} → {scenes.afterCount} scenes · {count('added')} added · {count('removed')} removed · {count('changed')} changed · {scenes.unchanged} unchanged matches</p>
    <p className="lw-compare-note">Matches require an exact unique heading, or a unique number with the same heading. Added and removed mean unmatched identifiers; renames cannot be linked. Scene spans exclude blank separators; the text comparison includes them.</p>
    {scenes.orderChanged && <p className="lw-compare-notice">Matched scene order changed.</p>}
    {(scenes.ambiguousBefore > 0 || scenes.ambiguousAfter > 0) && <p className="lw-compare-notice">Identity unresolved: {scenes.ambiguousBefore} From scenes and {scenes.ambiguousAfter} To scenes have repeated or conflicting headings/numbers. They are excluded from added, removed and changed counts.</p>}
    {!!scenes.differences.length && <ul className="lw-compare-scenes">
      {scenes.differences.slice(page * SCENE_PAGE_SIZE, (page + 1) * SCENE_PAGE_SIZE).map((scene, index) => {
        const ref = scene.after ?? scene.before!;
        return <li key={page * SCENE_PAGE_SIZE + index}><strong>{scene.type}</strong><span>{ref.number ? `#${ref.number} · ` : ''}{ref.heading.slice(0, DIFF_LINE_PREVIEW)}{ref.heading.length > DIFF_LINE_PREVIEW ? '…' : ''}<small>{scene.before ? `From position ${scene.before.index}` : ''}{scene.before && scene.after ? ' → ' : ''}{scene.after ? `To position ${scene.after.index}` : ''} · {scene.basis}</small></span></li>;
      })}
    </ul>}
    <Pages page={page} pages={pages} onPage={setPage} label="Scenes" />
  </section>;
}

function Comparison({ before, after }: { before: DraftRecord; after: DraftRecord }) {
  const result = useMemo(() => {
    try { return { value: compareSavedRevisions(before, after), error: '' }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : 'Comparison unavailable.' }; }
  }, [before, after]);
  if (!result.value) return <p role="alert">{result.error}</p>;
  const { metadata, text, scenes } = result.value;
  const display = (value: string | number | undefined) => value === undefined ? <em>Not set</em> : value === '' ? <em>Empty</em> : value;
  return <div className="lw-compare-result">
    <section aria-label="Metadata differences">
      <h3>Draft details</h3>
      {!metadata.some(row => row.changed) && <p className="lw-compare-note">Title, genre, logline and format details are unchanged.</p>}
      <div className="lw-compare-table-wrap"><table className="lw-compare-metadata"><caption className="sr-only">Saved metadata from v{before.version} to v{after.version}</caption><thead><tr><th>Field</th><th>From · v{before.version}</th><th>To · v{after.version}</th></tr></thead><tbody>
        {metadata.map(row => <tr key={row.field} data-changed={row.changed}><th scope="row">{row.label}{row.changed && <small>Changed</small>}</th><td>{display(row.before)}</td><td>{display(row.after)}</td></tr>)}
      </tbody></table></div>
    </section>
    <SceneSummary scenes={scenes} />
    <RevisionTextDiffView diff={text} />
  </div>;
}

export function RevisionComparePanel({ revisions, onSelectBaseline }: Props) {
  const sorted = useMemo(() => [...revisions].sort((a, b) => a.version - b.version), [revisions]);
  const [selection, setSelection] = useState(() => ({ before: sorted.length > 1 ? revisionKey(sorted[sorted.length - 2]) : '', after: sorted.length ? revisionKey(sorted[sorted.length - 1]) : '' }));
  const before = sorted.find(record => revisionKey(record) === selection.before) ?? sorted.at(-2);
  const after = sorted.find(record => revisionKey(record) === selection.after && record !== before) ?? [...sorted].reverse().find(record => record !== before);
  if (sorted.length < 2 || !before || !after) return <p className="lw-compare-note">Save at least two revisions of this draft to compare saved versions.</p>;
  return <section className="lw-revision-compare" aria-label="Saved revision comparison">
    <div><h2>Compare saved revisions</h2><p className="lw-compare-note">Changes run from the first selection to the second. Unsaved editor text is excluded.</p></div>
    <div className="lw-compare-selectors">
      {([['From revision', before, after, 'before'], ['To revision', after, before, 'after']] as const).map(([label, record, other, side]) => <label key={side}>{label}<select value={revisionKey(record)} onChange={event => setSelection({ before: revisionKey(before), after: revisionKey(after), [side]: event.target.value })}>
        {sorted.map(option => <option key={revisionKey(option)} value={revisionKey(option)} disabled={revisionKey(option) === revisionKey(other)}>v{option.version} · {option.data.title}</option>)}
      </select></label>)}
      <Button size="sm" variant="outline" onClick={() => setSelection({ before: revisionKey(after), after: revisionKey(before) })}>Swap revisions</Button>
    </div>
    <div className="lw-compare-identities">{([['From', before], ['To', after]] as const).map(([side, record]) => <section key={side} aria-label={`${side} saved identity`}>
      <h3>{side} · v{record.version} · {record.data.title}</h3><p className="lw-compare-note">Record {record.id}</p><code aria-label={`${side} stored SHA-256`}>{record.sha256}</code>
      {onSelectBaseline && <Button size="sm" variant="ghost" onClick={() => onSelectBaseline(record)}>Use v{record.version} as revision-mark baseline</Button>}
    </section>)}</div>
    <p className="lw-compare-note">SHA-256 values identify the stored records, including metadata. They are not body-only hashes.</p>
    <Comparison key={`${revisionKey(before)}:${revisionKey(after)}`} before={before} after={after} />
  </section>;
}
