import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, RefreshCw, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { downloadText } from '../model';
import { MAX_PRESERVATION_BYTES, preservationKind, type PreservationPreview, type PreservationVerification } from '../preservation';
import './preservation.css';

interface Props { beforeInspect: () => Promise<void>; onOpenDraft: (id: string) => void; onConnections: () => void; onBack: () => void }
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The local operation could not be completed.';

export function PreservationPanel({ beforeInspect, onOpenDraft, onConnections, onBack }: Props) {
  const [preview, setPreview] = useState<PreservationPreview | null>(null);
  const [busy, setBusy] = useState<'inspect' | 'export' | 'verify' | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [query, setQuery] = useState('');
  const [verification, setVerification] = useState<{ file: string; result: PreservationVerification } | null>(null);
  const picker = useRef<HTMLInputElement>(null), working = useRef(false), mounted = useRef(true);
  const inspectRef = useRef(beforeInspect); inspectRef.current = beforeInspect;
  const run = async (mode: 'inspect' | 'export' | 'verify', action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(mode); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(null); }
  };
  const inspect = () => run('inspect', async () => {
    await inspectRef.current();
    const next = await localApi.preservation.preview();
    if (mounted.current) setPreview(next);
  });
  useEffect(() => {
    mounted.current = true;
    void inspect();
    return () => { mounted.current = false; };
    // This panel inspects on entry; subsequent refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const exportPackage = () => run('export', async () => {
    if (!preview) return;
    await inspectRef.current();
    const value = await localApi.preservation.export(preview.sourceSha256);
    if (!mounted.current) return;
    downloadText('QiCanIScreenwrite-preservation.json', JSON.stringify(value), 'application/json');
    setNotice('Package prepared for download. Choose the saved file below to verify its contents.');
  });
  const verify = (file: File) => run('verify', async () => {
    setVerification(null);
    if (file.size > MAX_PRESERVATION_BYTES) throw new Error('Choose a preservation package no larger than 128 MiB.');
    let value: unknown;
    try { value = JSON.parse(await file.text()); } catch { throw new Error('This file is not a readable JSON preservation package.'); }
    const result = await localApi.preservation.verify(value);
    if (mounted.current) setVerification({ file: file.name, result });
  });
  const rows = preview?.inventory.filter(item => `${item.title} ${preservationKind[item.kind] ?? item.kind}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const recoveries = preview ? preview.recoveryCounts.screenplay + preview.recoveryCounts.development + (preview.recoveryCounts.rights ?? 0) : 0;

  return <section className="preservation-view" aria-label="Preservation">
    <header className="preservation-heading">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to writing</Button>
      <div><p className="lw-eyebrow">SAVED CREATIVE WORK</p><h1>Preservation</h1><p>Inspect saved screenplays, worlds, rights and transfer history. Packages include attached rights files and private terms. Keep them private.</p></div>
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void inspect()}><RefreshCw aria-hidden="true" />{busy === 'inspect' ? 'Inspecting…' : 'Refresh inventory'}</Button>
    </header>
    {error && <p role="alert" className="preservation-error">{error}</p>}
    {notice && <p role="status" className="preservation-message">{notice}</p>}
    {verification && <section className="preservation-verification" aria-label="Package verification" role="status"><p className="lw-eyebrow">FILE CONTENTS VERIFIED</p><h2>{verification.file}</h2><p>{verification.result.project.title} · {verification.result.recordCount} records · {verification.result.revisionCount} revisions</p><ul><li>Record and package checksums match.</li><li>Saved history and internal references validate.</li></ul><p className="preservation-help">This result applies to the selected file. It does not establish authorship, rights, independent copies or completed restoration.</p><details><summary>Verification scope & identity</summary><code>Package SHA-256 {verification.result.packageSha256}</code><ul>{verification.result.limitations.map(item => <li key={item}>{item}</li>)}</ul></details></section>}
    <div className="preservation-layout">
      <section aria-label="Saved inventory">
        <div className="preservation-section-heading"><h2>{preview?.project.title ?? 'Saved inventory'}</h2>{preview && <p>{preview.inventory.length} records · {preview.revisionCount} saved revisions</p>}</div>
        {preview && <>
          {recoveries > 0 && <p className="preservation-recovery" role="status">{recoveries} recovery {recoveries === 1 ? 'copy is' : 'copies are'} outside this package. Open and save the work you want included before exporting.</p>}
          <label className="preservation-search"><Search aria-hidden="true" /><input aria-label="Search preservation inventory" placeholder="Find a screenplay, world or receipt…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="preservation-table-wrap"><table><thead><tr><th scope="col">Saved item</th><th scope="col">Type</th><th scope="col">Revision</th></tr></thead><tbody>
            {rows.map(item => <tr key={item.id}><td>{item.kind === 'screenplay-draft' ? <button type="button" onClick={() => onOpenDraft(item.id)}>{item.title}</button> : <strong>{item.title}</strong>}<details><summary>Identity & checksum</summary><code>{item.id}</code><code>SHA-256 {item.sha256}</code></details></td><td>{preservationKind[item.kind] ?? item.kind}</td><td>v{item.version}</td></tr>)}
          </tbody></table></div>
          {!rows.length && <p className="preservation-empty">{preview.inventory.length ? 'No saved items match your search.' : 'No saved records yet. Save a screenplay or world to include it here.'}</p>}
        </>}
      </section>
      <aside className="preservation-actions" aria-label="Preservation actions">
        <section><h2>Keep a portable copy</h2><p>The package includes all saved revision history, a record inventory and a readable guide. New saved changes require a refreshed inventory.</p><Button disabled={!preview || busy !== null} onClick={() => void exportPackage()}><Download aria-hidden="true" />{busy === 'export' ? 'Preparing…' : 'Export saved package'}</Button><p className="preservation-help">Downloading starts a copy. It does not confirm where the file was saved or whether another storage copy exists.</p></section>
        <section><h2>Verify a saved package</h2><p>Check its hashes, saved history and internal references. Verification reads the file without importing it into this workspace.</p><input ref={picker} className="sr-only" type="file" accept=".json,application/json" aria-label="Choose preservation package" disabled={busy !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void verify(file); }} /><Button variant="outline" disabled={busy !== null} onClick={() => picker.current?.click()}><Upload aria-hidden="true" />{busy === 'verify' ? 'Verifying…' : 'Choose package to verify'}</Button></section>
        <section><h2>Production media</h2><p>QiMovi holds production and reference assets. This package includes originals retained through a reviewed screenplay import, together with their source receipts. Other Library assets, remote footage and masters stay in QiMovi.</p><Button size="sm" variant="link" onClick={onConnections}>Open QiMovi connection</Button></section>
        {preview && <details><summary>What this package excludes</summary><ul>{preview.exclusions.map(item => <li key={item}>{item}</li>)}</ul></details>}
      </aside>
    </div>

  </section>;
}
