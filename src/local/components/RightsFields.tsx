import type { ReactNode } from 'react';
import { recordRef, projectSubject, type EvidenceData, type ParticipationParty, type ParticipationSubject } from '../rights';
import type { WorkspaceRecord } from '../types';

export function RightsField({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`rights-field${wide ? ' rights-wide' : ''}`}><span>{label}</span>{children}</label>;
}

export function RightsSection({ title, help, action, children }: { title: string; help?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="rights-section" aria-label={title}><header><div><h2>{title}</h2>{help && <p>{help}</p>}</div>{action}</header>{children}</section>;
}

export function RightsPartySelect({ parties, value, onChange, label = 'Collaborator' }: { parties: ParticipationParty[]; value: string; onChange: (value: string) => void; label?: string }) {
  return <RightsField label={label}><select value={value} onChange={event => onChange(event.target.value)}><option value="">Choose a collaborator</option>{parties.map((party, index) => <option key={party.id} value={party.id}>{party.name || `Unnamed collaborator ${index + 1}`}</option>)}</select></RightsField>;
}

// Shared label formatting stays with these small rights-only controls.
// eslint-disable-next-line react-refresh/only-export-components
export function rightsRecordLabel(record: WorkspaceRecord) {
  const data = record.data as { name?: string; title?: string; filename?: string; draftId?: string };
  const kind = ({ 'screenplay-draft': 'Screenplay', 'story-development': 'Draft world', 'shared-world': 'Shared world', 'rights-evidence': 'Evidence', 'source-document': 'Original document' })[record.kind] ?? 'Saved item';
  return `${kind} · ${data.name || data.title || data.filename || data.draftId || record.id} · v${record.version}`;
}

export function RightsSubjectSelect({ records, value, onChange }: { records: WorkspaceRecord[]; value: ParticipationSubject; onChange: (value: ParticipationSubject) => void }) {
  const key = value.kind === 'PROJECT' ? '' : value.kind === 'ASSET' ? `asset:${value.assetHash}` : JSON.stringify(value.recordRef);
  const options = records.map(record => ({ record, key: JSON.stringify(recordRef(record)) }));
  const missing = key && !options.some(option => option.key === key);
  return <RightsField label="Applies to"><select value={key} onChange={event => {
    const selected = options.find(option => option.key === event.target.value)?.record;
    onChange(selected ? { kind: 'RECORD', label: rightsRecordLabel(selected), assetHash: null, recordRef: recordRef(selected) } : projectSubject());
  }}><option value="">Whole project</option>{missing && <option value={key}>{value.label || 'Previously selected subject'} · review saved source</option>}{options.map(option => <option key={option.key} value={option.key}>{rightsRecordLabel(option.record)}</option>)}</select></RightsField>;
}

export function RightsEvidenceSelect({ records, value, onChange }: { records: WorkspaceRecord<EvidenceData>[]; value: string[]; onChange: (value: string[]) => void }) {
  return <details className="rights-evidence-select"><summary>Evidence attachments · {value.length}</summary>{!records.length && <p className="rights-help">Upload evidence in the evidence section, then attach it here.</p>}{records.map(record => <label className="rights-checkbox" key={record.id}><input type="checkbox" checked={value.includes(record.data.sha256)} onChange={event => onChange(event.target.checked ? [...value, record.data.sha256] : value.filter(hash => hash !== record.data.sha256))} /><span>{record.data.name}</span></label>)}{value.filter(hash => !records.some(record => record.data.sha256 === hash)).map(hash => <label className="rights-checkbox" key={hash}><input type="checkbox" checked onChange={() => onChange(value.filter(item => item !== hash))} /><span>Unavailable evidence · {hash.slice(0, 12)}</span></label>)}</details>;
}

export function RightsSnapshot({ data }: { data: import('../rights').ProjectParticipation }) {
  const name = (id: string) => data.parties.find(party => party.id === id)?.name || 'Unnamed collaborator';
  const subject = (value: import('../rights').ParticipationSubject) => value.kind === 'PROJECT' ? 'Whole project' : value.label || 'Selected saved subject';
  const status = (value: string) => value === 'DOCUMENTED' ? 'Evidence attached' : value === 'DISPUTED' ? 'Disputed' : value === 'CLAIMED' ? 'Claimed' : 'Proposed';
  const amount = (value: number | null) => value === null ? 'Unknown' : (value / 100).toFixed(2);
  return <div className="rights-snapshot">
    <p>{data.parties.length} collaborators · {data.contributions.length} contributions · {data.rights.length} rights · {data.pools.length} pools</p>
    <ul>{data.parties.map(party => <li key={party.id}>{party.name || 'Unnamed collaborator'} · {party.kind === 'PERSON' ? 'Person' : 'Organization'}</li>)}</ul>
    {data.contributions.map(row => <p key={row.id}>
      <strong>{name(row.partyId)} · {row.role || 'Role unknown'}</strong><br />
      {subject(row.subject)}<br />{row.credit}<br />{row.description}<br />{row.evidenceHashes.length} evidence attachments
    </p>)}
    {data.rights.map(row => <p key={row.id}>
      <strong>{name(row.partyId)} · {row.rightType}</strong><br />{subject(row.subject)}<br />
      {row.scope || 'Scope unknown'} · {row.territory || 'Territory unknown'} · {row.term || 'Term unknown'}<br />
      {row.jurisdiction || 'Jurisdiction unknown'} · {status(row.status)} · {row.evidenceHashes.length} evidence attachments
    </p>)}
    {data.pools.map(pool => <div key={pool.id}>
      <strong>{pool.name || 'Unnamed pool'}</strong>
      <p>{({ COPYRIGHT_INTEREST: 'Copyright ownership', RECEIPTS: 'Receipts', DEFINED_PROCEEDS: 'Defined proceeds', COMPANY_EQUITY: 'Company equity' })[pool.kind]} · {subject(pool.subject)}</p>
      <p>{pool.definition || 'Terms unknown'}</p>
      {pool.entityName && <p>Company: {pool.entityName}</p>}
      {(pool.kind === 'RECEIPTS' || pool.kind === 'DEFINED_PROCEEDS') && <p>
        Currency: {pool.currency || 'Unknown'} · Receipts: {amount(pool.receiptsMinor)}
        {pool.kind === 'DEFINED_PROCEEDS' && <> · Deductions: {amount(pool.deductionsMinor)} · Recoupment: {amount(pool.recoupmentMinor)}</>}
      </p>}
      <ul>{pool.allocations.map(row => <li key={row.id}>
        {name(row.partyId)}: {row.shareBps === null ? 'Unknown share' : `${row.shareBps / 100}%`} · {status(row.agreementStatus)} · {row.evidenceHashes.length} evidence attachments
      </li>)}</ul>
    </div>)}
  </div>;
}
