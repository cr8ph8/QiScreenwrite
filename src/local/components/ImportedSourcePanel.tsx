import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { conversionLabel, MAX_IMPORT_BYTES } from '../import-review';
import type { SourceDocumentData, SourceImportData, SourceRef } from '../library-import';
import type { WorkspaceRecord } from '../types';
import './qimovi-library-panel.css';

export interface ImportedSourcePanelProps { draftId: string; records: WorkspaceRecord[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isRef = (value: unknown): value is SourceRef => object(value) && typeof value.id === 'string'
  && Number.isSafeInteger(value.version) && Number(value.version) > 0 && hash(value.sha256);
const matches = (record: WorkspaceRecord, ref: SourceRef) => record.id === ref.id && record.version === ref.version && record.sha256 === ref.sha256;

function isReceipt(record: WorkspaceRecord): record is WorkspaceRecord<SourceImportData> {
  const data = record.data;
  return record.kind === 'source-import' && object(data) && data.schemaVersion === 1 && data.status === 'REVIEWED_WORKING_COPY'
    && typeof data.projectId === 'string' && isRef(data.documentRef) && isRef(data.draftRef) && hash(data.bodySha256)
    && (data.conversion === 'FDX_REVIEWED' || data.conversion === 'FOUNTAIN_UTF8');
}

function isDocument(record: WorkspaceRecord): record is WorkspaceRecord<SourceDocumentData> {
  const data = record.data;
  return record.kind === 'source-document' && object(data) && data.schemaVersion === 1 && data.status === 'RETAINED_REFERENCE'
    && typeof data.projectId === 'string' && typeof data.filename === 'string' && typeof data.mimeType === 'string'
    && typeof data.base64 === 'string' && Number.isSafeInteger(data.byteLength) && Number(data.byteLength) > 0 && Number(data.byteLength) <= MAX_IMPORT_BYTES
    && hash(data.contentSha256) && object(data.origin) && data.origin.system === 'qimovi'
    && typeof data.origin.projectId === 'string' && typeof data.origin.projectTitle === 'string' && isRef(data.origin.recordRef);
}

function Reference({ label, value }: { label: string; value: SourceRef }) {
  return <><dt>{label}</dt><dd><code>{value.id}</code>v{value.version}<code>{value.sha256}</code></dd></>;
}

/** Uses the same local Blob/anchor mechanism as model.downloadText, without
 * decoding and re-encoding retained bytes (including any original UTF-8 BOM). */
function downloadOriginal(data: SourceDocumentData) {
  if (!data.filename || /[\\/]/.test(data.filename) || [...data.filename].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || data.filename === '.' || data.filename === '..') {
    throw new Error('The retained original has an invalid download filename.');
  }
  if (data.base64.length > 4 * Math.ceil(MAX_IMPORT_BYTES / 3)) throw new Error('The retained original exceeds the download limit.');
  const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0));
  if (bytes.length !== data.byteLength) throw new Error('The retained original does not match its saved byte length.');
  const url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = data.filename; anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function ImportedSourcePanel({ draftId, records }: ImportedSourcePanelProps) {
  const receipts = records.filter(isReceipt).filter(record => record.data.draftRef.id === draftId);
  return <section className="imported-source" aria-label="Imported source">
    <h3>Imported source</h3>
    {!receipts.length ? <p className="qimovi-library-help">No retained import source is linked to this draft.</p> : <>
      <p className="qimovi-library-help">This is a local working copy, not QiMovi’s canonical source. The receipt records the saved revision created at import; later writing changes do not alter the retained original.</p>
      {receipts.map(receipt => <SourceReceipt key={`${draftId}:${receipt.id}:${receipt.version}:${receipt.sha256}`} receipt={receipt}
        source={records.filter(isDocument).find(record => matches(record, receipt.data.documentRef) && record.data.projectId === receipt.data.projectId)} />)}
    </>}
  </section>;
}

function SourceReceipt({ receipt, source }: { receipt: WorkspaceRecord<SourceImportData>; source?: WorkspaceRecord<SourceDocumentData> }) {
  const detailsId = useId();
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const data = receipt.data;
  return <article aria-label={source ? `Imported from ${source.data.filename}` : 'Import receipt with unavailable original'}>
    {source && <>
      <strong>{source.data.filename}</strong>
      <p className="qimovi-library-help">QiMovi project: {source.data.origin.projectTitle}</p>
    </>}
    <p>{conversionLabel(data.conversion)}</p>
    {data.conversion === 'FDX_REVIEWED' && <p className="qimovi-library-help">User-reviewed Fountain conversion. Final Draft layout and metadata may differ; the retained original is the source reference.</p>}
    <p className="qimovi-library-help">Imported working draft v{data.draftRef.version}</p>
    <details id={detailsId}>
      <summary>Saved source and import receipt</summary>
      <dl className="qimovi-source-facts">
        {source && <>
          <dt>QiMovi project ID</dt><dd><code>{source.data.origin.projectId}</code></dd>
          <Reference label="QiMovi source revision" value={source.data.origin.recordRef} />
          <dt>Original bytes</dt><dd>{source.data.byteLength.toLocaleString()}</dd>
          <dt>Original SHA-256</dt><dd><code>{source.data.contentSha256}</code></dd>
        </>}
        <Reference label="Retained source document" value={data.documentRef} />
        <Reference label="Initial working draft revision" value={data.draftRef} />
        <dt>Imported Fountain SHA-256</dt><dd><code>{data.bodySha256}</code></dd>
        <Reference label="Import receipt" value={receipt} />
      </dl>
    </details>
    {source ? <Button type="button" size="sm" variant="outline" aria-describedby={detailsId} onClick={() => {
      setError(null); setDownloaded(false);
      try { downloadOriginal(source.data); setDownloaded(true); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The retained original could not be downloaded.'); }
    }}>Download retained original</Button> : <p role="alert" className="qimovi-library-help">The exact retained source document revision is unavailable. Its receipt is shown above; another revision will not be substituted.</p>}
    {error && <p role="alert" className="qimovi-library-notice">{error}</p>}
    {downloaded && <p role="status" className="qimovi-library-help">Retained original prepared for local download.</p>}
  </article>;
}
