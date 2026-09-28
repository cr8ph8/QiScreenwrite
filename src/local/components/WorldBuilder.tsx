import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronRight, Download, Globe2, Link2, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { canonicalJson, downloadText } from '../model';
import { WORLD_TYPES, newWorldElement, newWorldLink, removeWorldElement, worldMarkdown, type WorldData, type WorldElement, type WorldElementType, type WorldLink, type WorldStatus } from '../world';
import { resolveWorldLink, type WorldContext } from '../world-context';
import type { DevelopmentCharacter } from '../development';
import type { FilmcraftBrowse } from '../filmcraft';
import './world-builder.css';

interface Props {
  world: WorldData; notes: string; onNotes: (value: string) => void;
  onChange: (world: WorldData) => void; context: WorldContext;
  characters: DevelopmentCharacter[]; onJump?: (offset: number) => void;
  onBrowseFilmcraft?: (browse: FilmcraftBrowse) => void;
  focusElement?: { id: string; nonce: number };
}
const statusLabels: Record<WorldStatus, string> = { idea: 'Idea', established: 'Established in my story', needs_review: 'Needs review' };
const typeLabel = (type: string) => WORLD_TYPES.find(item => item.value === type)?.label ?? type;
const sameId = (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && a.toLowerCase() === b.toLowerCase();
const sameTarget = (type: WorldLink['targetType'], a: string, b: string) => type === 'element' ? sameId(a, b) : a === b;
interface RelinkReview {
  link: WorldLink;
  target: { ref: string; label: string; context: WorldContext } | null;
}

/** A controlled editor. The parent owns durable recovery, CAS saves and history. */
export function WorldBuilder({ world, notes, onNotes, onChange, context, characters, onJump, onBrowseFilmcraft, focusElement }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [newType, setNewType] = useState<WorldElementType>('location');
  const [detail, setDetail] = useState('overview');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [removed, setRemoved] = useState<{ before: WorldData; after: string } | null>(null);
  const [linkType, setLinkType] = useState<WorldLink['targetType']>('element');
  const [target, setTarget] = useState('');
  const [linkNotes, setLinkNotes] = useState('');
  const [relink, setRelink] = useState<RelinkReview | null>(null);
  const [notice, setNotice] = useState('');
  const latestWorld = useRef(world);
  latestWorld.current = world;
  const focusId = focusElement?.id, focusNonce = focusElement?.nonce;
  useEffect(() => {
    const match = latestWorld.current.elements.find(item => sameId(item.id, focusId));
    if (!match) return;
    setSelected(match.id); setFilter('all'); setQuery(''); setReviewOnly(false); setDetail('overview');
  }, [focusId, focusNonce]);
  const nameId = useId();
  const sorted = useMemo(() => [...world.elements].sort((a, b) => a.order - b.order), [world.elements]);
  const stale = world.links.filter(link => link.targetType !== 'element' && !resolveWorldLink(link, context));
  const requiresReview = (item: WorldElement) => item.status === 'needs_review' || !item.name.trim() || !item.description.trim() || stale.some(link => sameId(link.elementId, item.id));
  const reviewCount = world.elements.filter(requiresReview).length;
  const visible = sorted.filter(item => (filter === 'all' || item.type === filter) && (!reviewOnly || requiresReview(item)) && `${item.name} ${item.description} ${item.storyFunction} ${item.continuity}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const element = world.elements.find(item => sameId(item.id, selected));
  const elementLinks = world.links.filter(link => sameId(link.elementId, element?.id));
  const inbound = world.links.filter(link => link.targetType === 'element' && sameId(link.targetRef, element?.id));
  const targets = linkType === 'element' ? sorted.filter(item => !sameId(item.id, element?.id)).map(item => ({ ref: item.id, label: item.name || `Untitled ${typeLabel(item.type).toLowerCase()}` })) : context[linkType === 'scene' ? 'scenes' : 'characters'];
  const relinkTargets = context[relink?.link.targetType === 'scene' ? 'scenes' : 'characters'];
  const relinkTarget = relink?.target?.context === context ? relinkTargets.find(item => item.ref === relink.target!.ref && item.label === relink.target!.label) : undefined;
  const change = (next: WorldData) => { setNotice(''); onChange(next); };
  const select = (id: string) => { setSelected(id); setTarget(''); setLinkNotes(''); setRelink(null); setDetail('overview'); };
  const add = (type: WorldElementType, name = '', description = '') => {
    if (world.elements.length >= 300) return;
    if (name.length > 160 || description.length > 8000) { setNotice('This text exceeds the world element limit. It has been kept in its original location.'); return; }
    const item = { ...newWorldElement(type), name, description, order: Math.max(-1, ...world.elements.map(item => item.order)) + 1 };
    change({ ...world, elements: [...world.elements, item] }); setFilter('all'); setQuery(''); setReviewOnly(false); select(item.id);
  };
  const edit = (values: Partial<WorldElement>) => { if (element) change({ ...world, elements: world.elements.map(item => sameId(item.id, element.id) ? { ...item, ...values } : item) }); };
  const remove = () => {
    if (!element) return;
    const next = removeWorldElement(world, element.id);
    setRemoved({ before: world, after: canonicalJson(next) }); change(next); setSelected(null); setRelink(null);
  };
  const move = (direction: number) => {
    if (!element) return;
    const group = sorted.filter(item => item.type === element.type), index = group.findIndex(item => sameId(item.id, element.id)), other = group[index + direction];
    if (!other) return;
    const reordered = [...sorted], a = reordered.findIndex(item => sameId(item.id, element.id)), b = reordered.findIndex(item => sameId(item.id, other.id));
    [reordered[a], reordered[b]] = [reordered[b], reordered[a]];
    change({ ...world, elements: reordered.map((item, index) => ({ ...item, order: index })) });
  };
  const addLink = () => {
    const match = targets.find(item => sameTarget(linkType, item.ref, target));
    if (!element || !match || world.links.length >= 1000) return;
    if (elementLinks.some(link => link.targetType === linkType && sameTarget(linkType, link.targetRef, match.ref))) { setNotice('This connection already exists.'); return; }
    change({ ...world, links: [...world.links, { ...newWorldLink(element.id, linkType, match.ref, match.label), notes: linkNotes }] }); setTarget(''); setLinkNotes('');
  };
  const applyRelink = () => {
    if (!relink) return;
    const current = world.links.find(link => sameId(link.id, relink.link.id));
    if (!current || !sameId(current.elementId, relink.link.elementId) || !sameId(current.elementId, element?.id) || current.targetType !== relink.link.targetType || current.targetRef !== relink.link.targetRef || current.targetLabel !== relink.link.targetLabel) {
      setNotice('This connection changed. Cancel and review it again.'); return;
    }
    if (!relinkTarget) { setNotice('The screenplay changed. Choose a current replacement target.'); return; }
    if (elementLinks.some(link => !sameId(link.id, current.id) && link.targetType === current.targetType && sameTarget(current.targetType, link.targetRef, relinkTarget.ref))) {
      setNotice('This connection already exists. Choose another target or cancel.'); return;
    }
    // Preserve the latest link's UUID, source, type and notes; only its target changes.
    change({ ...world, links: world.links.map(link => sameId(link.id, current.id) ? { ...link, targetRef: relinkTarget.ref, targetLabel: relinkTarget.label } : link) });
    setRelink(null);
  };
  const addCharacter = (character: DevelopmentCharacter) => add('character', character.name, [character.role, character.description, character.arc && `Arc: ${character.arc}`].filter(Boolean).join('\n\n'));
  const already = (type: WorldElementType, name: string) => world.elements.some(item => item.type === type && item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const exportBible = () => {
    try { downloadText('world-bible.md', `# World bible\n\n${notes}\n\n${worldMarkdown(world)}`, 'text/markdown;charset=utf-8'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The world bible could not be exported. Your work is still here.'); }
  };

  return <div className="world-builder">
    <div className="world-toolbar">
      <p><Globe2 aria-hidden="true" /><strong>{world.elements.length}</strong> elements <span>·</span> <strong>{world.links.length}</strong> connections</p>
      <div><Button type="button" size="sm" variant={reviewOnly ? 'secondary' : 'ghost'} aria-pressed={reviewOnly} onClick={() => setReviewOnly(value => !value)}>Review {reviewCount > 0 && `(${reviewCount})`}</Button><Button type="button" size="sm" variant="ghost" onClick={exportBible}><Download aria-hidden="true" />Export bible</Button></div>
    </div>
    <details className="world-premise"><summary>World overview <span>Setting, tone and the central promise of this world</span></summary><Text label="World overview" value={notes} max={24000} rows={4} onChange={onNotes} /></details>
    {removed && canonicalJson(world) === removed.after && <div className="world-notice" role="status">Element and its connections removed.<Button type="button" size="sm" variant="link" onClick={() => { onChange(removed.before); setRemoved(null); }}>Undo removal</Button></div>}
    {notice && <p role="status" className="world-notice">{notice}</p>}
    {reviewOnly && <p className="world-review-explanation">Review shows elements marked “Needs review,” missing a name or description, or linked to a scene or character that has changed. These are writing reminders.</p>}
    <nav className="world-filters" aria-label="World categories">
      <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span>{world.elements.length}</span></button>
      {WORLD_TYPES.map(type => <button type="button" key={type.value} aria-pressed={filter === type.value} onClick={() => setFilter(type.value)}>{type.plural}<span>{world.elements.filter(item => item.type === type.value).length}</span></button>)}
    </nav>
    <div className="world-columns">
      <aside className="world-index" aria-label="World elements">
        <label className="world-search"><Search aria-hidden="true" /><input aria-label="Search world" placeholder="Search your world…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="world-add"><select aria-label="New element type" value={newType} onChange={event => setNewType(event.target.value as WorldElementType)}>{WORLD_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select><Button type="button" size="sm" onClick={() => add(newType)} disabled={world.elements.length >= 300}><Plus aria-hidden="true" />Add</Button></div>
        <div className="world-element-list">
          {visible.map(item => <button type="button" className="world-element" aria-pressed={sameId(item.id, selected)} key={item.id} onClick={() => select(item.id)}><span className="world-element-type">{typeLabel(item.type)}{item.status === 'established' && <Check aria-label="Established" />}{requiresReview(item) && <i title="Writing reminder" />}</span><strong>{item.name || `Untitled ${typeLabel(item.type).toLowerCase()}`}</strong><span className="world-element-excerpt">{item.description || 'Add a description…'}</span></button>)}
          {!visible.length && world.elements.length > 0 && <p className="world-no-results">No elements match. <button type="button" onClick={() => { setQuery(''); setFilter('all'); setReviewOnly(false); }}>Show all</button></p>}
        </div>
      </aside>
      <section className="world-detail" aria-label="World element editor">
        {element ? <>
          <header className="world-detail-header"><span className="world-kicker">{typeLabel(element.type)}</span><div><Button type="button" size="sm" variant="ghost" title="Move earlier in this category" aria-label="Move element earlier" disabled={sameId(sorted.filter(item => item.type === element.type)[0]?.id, element.id)} onClick={() => move(-1)}><ArrowUp /></Button><Button type="button" size="sm" variant="ghost" title="Move later in this category" aria-label="Move element later" disabled={sameId(sorted.filter(item => item.type === element.type).at(-1)?.id, element.id)} onClick={() => move(1)}><ArrowDown /></Button><Button type="button" size="sm" variant="ghost" aria-label="Remove world element" onClick={remove}><Trash2 /></Button></div></header>
          <label htmlFor={nameId} className="sr-only">Element name</label><input id={nameId} className="world-name" value={element.name} placeholder={`Name this ${typeLabel(element.type).toLowerCase()}`} maxLength={160} onChange={event => edit({ name: event.target.value })} />
          <div className="world-identity"><label>Type<select aria-label="Element type" value={element.type} onChange={event => edit({ type: event.target.value as WorldElementType })}>{WORLD_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label><label>Story status<select aria-label="Story status" value={element.status} onChange={event => edit({ status: event.target.value as WorldStatus })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="world-detail-tabs" role="group" aria-label="Element sections">{[['overview', 'Overview'], ['story', 'Story & continuity'], ['links', `Connections (${elementLinks.length + inbound.length})`]].map(([value, label]) => <button type="button" key={value} aria-pressed={detail === value} onClick={() => setDetail(value)}>{label}</button>)}</div>
          {detail === 'overview' && <div className="world-fields"><p className="world-prompt">{WORLD_TYPES.find(type => type.value === element.type)?.prompt}</p><Text label="Description" value={element.description} max={8000} rows={7} onChange={description => edit({ description })} /><Text label="On screen & in sound" hint="What can the audience see or hear? Consider setting, blocking, props, light and sound." value={element.sensoryDetails} max={4000} rows={4} onChange={sensoryDetails => edit({ sensoryDetails })} />{onBrowseFilmcraft && <button type="button" className="world-reference" onClick={() => onBrowseFilmcraft({ category: 'image', query: 'Mise-en-scène' })}><BookOpen aria-hidden="true" />Explore visual choices in Film language<ChevronRight aria-hidden="true" /></button>}</div>}
          {detail === 'story' && <div className="world-fields"><Text label="Story function" hint="How does this create conflict, reveal character or develop a theme? What changes because it exists?" value={element.storyFunction} max={4000} rows={6} onChange={storyFunction => edit({ storyFunction })} /><Text label="Continuity & open questions" hint="Record constraints, exceptions, cause and effect, and details to keep consistent between scenes." value={element.continuity} max={4000} rows={6} onChange={continuity => edit({ continuity })} />{onBrowseFilmcraft && <button type="button" className="world-reference" onClick={() => onBrowseFilmcraft({ category: 'story', query: 'character' })}><BookOpen aria-hidden="true" />{element.type === 'thematic_note' ? 'Explore intention in Film language' : 'Explore story theory'}<ChevronRight aria-hidden="true" /></button>}</div>}
          {detail === 'links' && <div className="world-fields">
            <p className="world-prompt">Connect this element to another part of your world, a scene, or a character cue in this draft.</p>
            {elementLinks.map(link => {
              const linked = link.targetType === 'element' ? world.elements.find(item => sameId(item.id, link.targetRef)) : null;
              const resolved = resolveWorldLink(link, context), missing = link.targetType !== 'element' && !resolved;
              const reviewing = sameId(relink?.link.id, link.id);
              return <div className="world-link" role="group" aria-label={`Connection to ${linked?.name || link.targetLabel}`} key={link.id}><Link2 aria-hidden="true" /><div><span>{link.targetType}</span><strong>{linked?.name || link.targetLabel}</strong>{link.notes && <p>{link.notes}</p>}
                {missing && <p className="world-link-warning">Source changed or is missing. Review and relink to keep this connection's notes.</p>}
                {missing && !reviewing && <button type="button" onClick={() => { setRelink({ link: { ...link }, target: null }); setNotice(''); }}>Relink connection</button>}
                {reviewing && <fieldset className="world-link-form">
                  <legend>Relink connection</legend>
                  <p>Choose the current {link.targetType === 'scene' ? 'scene' : 'character cue'}. Connection notes will be kept.</p>
                  <select aria-label="Replacement target" value={relinkTarget?.ref ?? ''} onChange={event => {
                    const next = relinkTargets.find(item => item.ref === event.target.value);
                    setRelink({ link: relink!.link, target: next ? { ref: next.ref, label: next.label, context } : null }); setNotice('');
                  }}><option value="">Choose a replacement…</option>{relinkTargets.map(item => <option key={item.ref} value={item.ref}>{item.label}</option>)}</select>
                  {relink?.target && !relinkTarget && <p role="alert">The screenplay changed. Choose a current replacement target.</p>}
                  <Button type="button" size="sm" disabled={!relinkTarget} onClick={applyRelink}>Apply relink</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setRelink(null); setNotice(''); }}>Cancel relink</Button>
                </fieldset>}
                {linked && <button type="button" onClick={() => select(linked.id)}>Open element</button>}
                {resolved?.offset !== undefined && onJump && <button type="button" onClick={() => onJump(resolved.offset!)}>{link.targetType === 'character' ? 'Go to character' : 'Go to scene'}</button>}
              </div><Button type="button" size="sm" variant="ghost" aria-label={`Remove connection to ${linked?.name || link.targetLabel}`} onClick={() => { change({ ...world, links: world.links.filter(item => !sameId(item.id, link.id)) }); if (reviewing) setRelink(null); }}><Trash2 /></Button></div>;
            })}
            {inbound.map(link => <div className="world-inbound" key={link.id}>Linked from <button type="button" onClick={() => select(link.elementId)}>{world.elements.find(item => sameId(item.id, link.elementId))?.name || 'Untitled element'}</button>{link.notes && <p>{link.notes}</p>}</div>)}
            <div className="world-link-form"><h3>Add a connection</h3><div className="world-link-selects"><select aria-label="Connection type" value={linkType} onChange={event => { setLinkType(event.target.value as WorldLink['targetType']); setTarget(''); }}><option value="element">World element</option><option value="scene">Screenplay scene</option><option value="character">Character cue</option></select><select aria-label="Connection target" value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose a target…</option>{targets.map(item => <option key={item.ref} value={item.ref}>{item.label}</option>)}</select></div><Text label="Connection notes" value={linkNotes} max={2000} rows={2} onChange={setLinkNotes} /><Button type="button" size="sm" disabled={!target || world.links.length >= 1000} onClick={addLink}><Plus aria-hidden="true" />Add connection</Button>{linkType === 'scene' && context.ambiguousScenes > 0 && <p className="world-prompt">{context.ambiguousScenes} scene(s) need unique scene numbers or headings before linking. This prevents connections from pointing to the wrong scene.</p>}</div>
          </div>}
        </> : <div className="world-welcome"><Globe2 aria-hidden="true" /><p className="world-kicker">Your story world</p><h3>{world.elements.length ? 'Choose an element to develop.' : 'Build a world the audience can believe.'}</h3><p>Define the people, places and rules of your story. Connect them to the screenplay as it takes shape.</p>{!world.elements.length && <div className="world-starters">{WORLD_TYPES.map(type => <button type="button" key={type.value} onClick={() => add(type.value)}><Plus aria-hidden="true" />{type.label}</button>)}</div>}</div>}
      </section>
    </div>
    {(context.characters.length > 0 || context.locations.length > 0 || characters.some(item => item.name.trim())) && <details className="world-from-script"><summary>Bring in names from your screenplay & development <span>Choose what belongs in this world.</span></summary><div>{characters.filter(item => item.name.trim() && item.name.length <= 160 && [item.role, item.description, item.arc && `Arc: ${item.arc}`].filter(Boolean).join('\n\n').length <= 8000).map(item => <button type="button" disabled={already('character', item.name) || world.elements.length >= 300} key={item.id} onClick={() => addCharacter(item)}><Plus aria-hidden="true" />{item.name}<span>Development character</span></button>)}{context.characters.filter(item => item.label.length <= 160).map(item => <button type="button" disabled={already('character', item.label) || world.elements.length >= 300} key={`cue:${item.ref}`} onClick={() => add('character', item.label)}><Plus aria-hidden="true" />{item.label}<span>Character cue</span></button>)}{context.locations.filter(item => item.length <= 160).map(item => <button type="button" disabled={already('location', item) || world.elements.length >= 300} key={`location:${item}`} onClick={() => add('location', item)}><Plus aria-hidden="true" />{item}<span>Scene location</span></button>)}</div></details>}
  </div>;
}

function Text({ label, hint, value, max, rows, onChange }: { label: string; hint?: string; value: string; max: number; rows: number; onChange: (value: string) => void }) {
  const id = useId();
  return <div className="world-field"><div><label htmlFor={id}>{label}</label><span>{value.length.toLocaleString()} / {max.toLocaleString()}</span></div>{hint && <p id={`${id}-hint`}>{hint}</p>}<Textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} value={value} maxLength={max} rows={rows} onChange={event => onChange(event.target.value)} /></div>;
}
