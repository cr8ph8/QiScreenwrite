import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { downloadText } from '../model';
import { emptyPublicFields, newRightsId, parseSharePercent, randomNonce, recordRef, sameRef, validateTokenDraft, type PublicTokenFields, type TokenDraftData, type TokenPreview } from '../rights';
import type { LocalProject, RecordInput, WorkspaceRecord } from '../types';
import { RightsField, RightsSection, rightsRecordLabel } from './RightsFields';

interface Props {
  project: LocalProject;
  ledger: WorkspaceRecord | undefined;
  subjects: WorkspaceRecord[];
  tokens: WorkspaceRecord<TokenDraftData>[];
  disabled: boolean;
  onSaved: (record: WorkspaceRecord) => void;
  onDirtyChange: (dirty: boolean) => void;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The local operation failed. Try again.';
const publicLabels: Record<keyof PublicTokenFields, string> = { name: 'Public name', description: 'Public description', imageUri: 'Public image URL', licenceUri: 'Public licence URL', licenceSummary: 'Public licence summary' };

export function RightsTokenPreparation({ project, ledger, subjects, tokens, disabled, onSaved, onDirtyChange }: Props) {
  const [subjectKey, setSubjectKey] = useState('');
  const [standard, setStandard] = useState<TokenDraftData['standard']>('UNDECIDED');
  const [edition, setEdition] = useState(''), [royalty, setRoyalty] = useState('');
  const [fields, setFields] = useState<PublicTokenFields>(emptyPublicFields);
  const [pending, setPending] = useState<RecordInput<TokenDraftData> | null>(null);
  const [preview, setPreview] = useState<TokenPreview | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const formKey = JSON.stringify({ subjectKey, standard, edition, royalty, fields });
  const [savedFormKey, setSavedFormKey] = useState(formKey);
  const formDirty = formKey !== savedFormKey || !!pending;
  useEffect(() => { onDirtyChange(formDirty); }, [formDirty, onDirtyChange]);
  const working = useRef(false), mounted = useRef(true);
  const context = useRef({ ledger, subjects, tokens, disabled }); context.current = { ledger, subjects, tokens, disabled };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fresh = (token: TokenDraftData) => sameRef(token.participationRef, context.current.ledger) && sameRef(token.subjectRef, context.current.subjects.find(row => row.id === token.subjectRef.id));
  const previewRecord = tokens.find(token => preview && sameRef(preview.recordRef, token));
  const previewFresh = Boolean(previewRecord && fresh(previewRecord.data));
  const run = async (mode: string, action: () => Promise<void>) => {
    if (working.current || context.current.disabled) return;
    working.current = true; setBusy(mode); setError(''); setNotice('');
    try { await action(); } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(''); }
  };
  const save = () => run('save', async () => {
    let input = pending;
    if (!input) {
      const subject = subjects.find(row => JSON.stringify(recordRef(row)) === subjectKey);
      if (!ledger || !subject) throw new Error('Choose a current saved subject and save the rights draft first.');
      if (edition && (!/^[1-9]\d*$/.test(edition) || Number(edition) > 1000000)) throw new Error('Edition cap must be a whole number from 1 to 1,000,000, or blank.');
      const data: TokenDraftData = { schemaVersion: 1, projectId: project.id, status: 'DRAFT', subjectRef: recordRef(subject), participationRef: recordRef(ledger), standard, editionCap: edition ? Number(edition) : null, royaltyRequestBps: parseSharePercent(royalty), publicFields: { ...fields }, nonce: randomNonce() };
      validateTokenDraft(data, project);
      input = { id: newRightsId('token-preparation'), kind: 'token-preparation', expectedVersion: null, requestId: newRightsId('request'), data };
      setPending(input);
    }
    const saved = await localApi.save(input);
    if (!mounted.current) return;
    setPending(null); setSavedFormKey(formKey); setPreview(null); onSaved(saved);
    setNotice('Token preparation saved locally. Preview its public JSON before exporting.');
  });
  const showPreview = (token: WorkspaceRecord<TokenDraftData>) => run('preview', async () => {
    setPreview(null);
    const value = await localApi.rights.tokenPreview(recordRef(token));
    if (!mounted.current) return;
    if (!fresh(token.data)) throw new Error('The saved rights or subject changed. Save a new token preparation, then preview again.');
    setPreview(value);
  });
  const exportPreview = () => run('export', async () => {
    if (!preview || !previewRecord || !fresh(previewRecord.data)) throw new Error('This preview is stale. Save and preview a new token preparation.');
    const metadata = await localApi.rights.tokenExport(preview.recordRef, preview.metadataSha256);
    if (!mounted.current) return;
    if (context.current.disabled || !fresh(previewRecord.data)) throw new Error('Saved work changed while exporting. Review a new preview.');
    downloadText('token-metadata-draft.json', JSON.stringify(metadata, null, 2), 'application/json');
    setNotice('Public JSON prepared for download. Nothing was published or minted.');
  });
  return <RightsSection title="Future token preparation" help="Prepare a local metadata draft for possible blockchain or NFT integration.">
    <p className="rights-help">No wallet connection, network transaction or minting. A royalty request is separate from co-writer splits; enforcement is not guaranteed.</p>
    <fieldset disabled={disabled || !!busy || !!pending} className="rights-fieldset"><div className="rights-grid">
      <RightsField label="Token subject"><select value={subjectKey} onChange={event => setSubjectKey(event.target.value)}><option value="">Choose saved screenplay, world or evidence</option>{subjectKey && !subjects.some(row => JSON.stringify(recordRef(row)) === subjectKey) && <option value={subjectKey}>Previously selected subject changed · choose again</option>}{subjects.map(record => <option key={record.id} value={JSON.stringify(recordRef(record))}>{rightsRecordLabel(record)}</option>)}</select></RightsField>
      <RightsField label="Token standard"><select value={standard} onChange={event => setStandard(event.target.value as typeof standard)}><option value="UNDECIDED">Undecided</option><option value="ERC721">ERC-721</option><option value="ERC1155">ERC-1155</option></select></RightsField>
      <RightsField label="Edition cap (optional)"><input inputMode="numeric" placeholder="Undecided" value={edition} onChange={event => setEdition(event.target.value)} /></RightsField>
      <RightsField label="Royalty request (%) (optional)"><input inputMode="decimal" placeholder="Unknown" value={royalty} onChange={event => setRoyalty(event.target.value)} /></RightsField>
      {(Object.keys(publicLabels) as (keyof PublicTokenFields)[]).map(key => <RightsField key={key} label={publicLabels[key]} wide={key === 'description' || key === 'licenceSummary'}>{key === 'description' || key === 'licenceSummary' ? <textarea rows={2} maxLength={key === 'description' ? 8000 : 4000} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} /> : <input maxLength={key === 'name' ? 240 : 2048} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} />}</RightsField>)}
    </div></fieldset>
    <p className="rights-help">Only text entered in public fields is copied to the public description. Leave private names, agreements and source text out of these fields. Public URLs must use HTTPS or IPFS without credentials or query parameters. A public name is required to export.</p>
    {pending && <p className="rights-message">Save unconfirmed. Retry sends the same preparation and request. Editing is paused.</p>}
    <div className="rights-actions"><Button size="sm" variant="outline" disabled={disabled || !!busy || !ledger} onClick={() => void save()}>{busy === 'save' ? 'Saving preparation…' : pending ? 'Retry preparation save' : 'Save token preparation'}</Button>{pending && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setPending(null); setNotice('Pending retry discarded. A save may already exist; refresh saved records before creating another.'); }}>Discard preparation retry</Button>}</div>
    {formDirty && <><p className="rights-message">Token field edits are not recovered automatically. Save the preparation or explicitly discard these edits before quitting.</p><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setSubjectKey(''); setStandard('UNDECIDED'); setEdition(''); setRoyalty(''); setFields(emptyPublicFields()); setPending(null); setSavedFormKey(JSON.stringify({ subjectKey: '', standard: 'UNDECIDED', edition: '', royalty: '', fields: emptyPublicFields() })); }}>Discard token edits</Button></>}
    {!ledger && <p className="rights-help">Save the rights draft before preparing a token.</p>}
    {error && <p role="alert" className="rights-error">{error}</p>}{notice && <p role="status" className="rights-message">{notice}</p>}
    <div className="rights-token-list"><h3>Saved token preparations</h3>{!tokens.length && <p className="rights-empty">None saved yet.</p>}{tokens.map(token => <div className="rights-token-row" key={token.id}><div><strong>{token.data.publicFields.name || 'Untitled preparation'}</strong><p>{token.data.standard === 'UNDECIDED' ? 'Standard undecided' : token.data.standard} · {fresh(token.data) ? 'Current saved sources' : 'Sources changed · create a new preparation'}</p></div><Button size="sm" variant="outline" disabled={disabled || !!busy || !fresh(token.data)} onClick={() => void showPreview(token)}>Preview public JSON</Button></div>)}</div>
    {preview && <section className="rights-public-preview" aria-label="Public JSON preview"><h3>Public JSON preview</h3><p className="rights-help">This is the actual public metadata returned by the local service. Private names and terms, evidence bytes and filenames, screenplay/world content, source identities and the private nonce are excluded unless you typed them into public fields.</p><pre tabIndex={0}>{JSON.stringify(preview.metadata, null, 2)}</pre>{!previewFresh && <p className="rights-error" role="alert">This preview is stale. Save a new preparation against the latest sources.</p>}<Button size="sm" disabled={disabled || !!busy || !previewFresh} onClick={() => void exportPreview()}>{busy === 'export' ? 'Preparing download…' : 'Export shown public JSON'}</Button></section>}
  </RightsSection>;
}
