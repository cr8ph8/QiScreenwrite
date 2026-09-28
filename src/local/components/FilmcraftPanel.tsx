import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FILMCRAFT_CATALOG, FILMCRAFT_CATEGORIES, FILMCRAFT_KINDS, filmcraftSourceLabel, filmcraftSourceUrl, searchFilmcraft, type FilmcraftBrowse, type FilmcraftCategory, type FilmcraftKind, type FilmcraftResearchResult } from '../filmcraft';

export interface FilmcraftPanelProps {
  canAddResearch: boolean;
  onAddResearch: (entryId: string) => FilmcraftResearchResult;
  active?: boolean;
  /** Global Knowledge can be browsed without an open screenplay. */
  referenceOnly?: boolean;
  /** A fresh object represents an explicit request to browse a context/selection. */
  browse?: FilmcraftBrowse;
}

export function FilmcraftPanel({ canAddResearch, onAddResearch, active = true, referenceOnly = false, browse }: FilmcraftPanelProps) {
  const id = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(browse?.query ?? '');
  const [category, setCategory] = useState<FilmcraftCategory | 'all'>(browse?.category ?? 'all');
  const [kind, setKind] = useState<FilmcraftKind | 'all'>(browse?.kind ?? 'all');
  const [selected, setSelected] = useState('');
  const [feedback, setFeedback] = useState<FilmcraftResearchResult | null>(null);
  useEffect(() => {
    if (!browse) return;
    setQuery((browse.query ?? '').slice(0, 200)); setCategory(browse.category ?? 'all'); setKind(browse.kind ?? 'all'); setFeedback(null);
  }, [browse]);
  useEffect(() => { if (active) searchInput.current?.focus(); }, [active, browse]);
  const results = useMemo(() => searchFilmcraft({ query, category, kind }), [query, category, kind]);
  const entry = results.find(item => item.id === selected) ?? results[0];
  const reset = () => { setQuery(''); setCategory('all'); setKind('all'); searchInput.current?.focus(); };

  return <section aria-labelledby={`${id}-heading`} className="flex min-h-0 flex-col">
    <header className="mb-4 flex items-start gap-3"><BookOpen className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden="true" /><div><h2 id={`${id}-heading`} className="font-semibold tracking-tight">Film language</h2><p className="mt-1 text-xs text-muted-foreground">Local reference · {FILMCRAFT_CATALOG.entries.length} entries · no connection needed to read</p></div></header>
    <div role="search" aria-label="Film language reference" className="space-y-3">
      <label htmlFor={`${id}-search`} className="sr-only">Search film language</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" /><Input ref={searchInput} id={`${id}-search`} type="search" className="pl-9" value={query} maxLength={200} placeholder="Search terms, aliases, or ideas" onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs font-medium">Category<select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={category} onChange={event => setCategory(event.target.value as FilmcraftCategory | 'all')}><option value="all">All categories</option>{Object.entries(FILMCRAFT_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs font-medium">Kind<select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={kind} onChange={event => setKind(event.target.value as FilmcraftKind | 'all')}><option value="all">All kinds</option>{Object.entries(FILMCRAFT_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <Button type="button" variant="ghost" size="sm" onClick={reset}>Clear filters</Button>
      </div>
    </div>
    <p role="status" className="my-3 text-xs text-muted-foreground">{results.length} {results.length === 1 ? 'entry' : 'entries'}{query.trim() ? ` matching “${query.trim()}”` : ''}</p>
    {feedback && <p role={feedback.ok ? 'status' : 'alert'} className="mb-3 text-sm">{feedback.message}</p>}
    {!results.length ? <div className="border-t border-border py-8 text-center"><p>No matching film language.</p><p className="mt-1 text-xs text-muted-foreground">Try a shorter phrase or clear a filter.</p><Button type="button" variant="link" onClick={reset}>Browse all entries</Button></div> :
      <div className="grid min-h-0 gap-5 border-t border-border pt-3 md:grid-cols-[minmax(150px,0.8fr)_minmax(0,2fr)]">
        <nav aria-label="Film language results" className="max-h-52 overflow-auto md:max-h-[60vh]"><ul className="space-y-1">{results.map(item => <li key={item.id}><button type="button" aria-pressed={entry?.id === item.id} className={`w-full rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry?.id === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`} onClick={() => { setSelected(item.id); setFeedback(null); }}><span className="block text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-[11px]">{FILMCRAFT_CATEGORIES[item.category]} · {FILMCRAFT_KINDS[item.kind]}</span></button></li>)}</ul></nav>
        {entry && <article aria-labelledby={`${id}-title`} className="min-w-0 space-y-4">
          <div><p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{FILMCRAFT_CATEGORIES[entry.category]} / {FILMCRAFT_KINDS[entry.kind]}</p><h3 id={`${id}-title`} className="text-lg font-semibold tracking-tight">{entry.title}</h3>{entry.aliases.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Also called {entry.aliases.join(' · ')}</p>}</div>
          <p className="leading-relaxed">{entry.definition}</p>
          <div><h4 className="mb-1 text-xs font-semibold">In practice</h4><p className="text-sm leading-relaxed text-muted-foreground">{entry.application}</p></div>
          <div className="border-l-2 border-primary pl-3"><h4 className="mb-1 text-xs font-semibold">Writing prompt</h4><p className="text-sm leading-relaxed">{entry.prompt}</p></div>
          {referenceOnly ? <p className="text-xs text-muted-foreground">To attach a reference to a screenplay, open its workspace and choose Film language → Add to research.</p> : <div><Button type="button" size="sm" variant="outline" disabled={!canAddResearch} aria-describedby={!canAddResearch ? `${id}-save-first` : undefined} onClick={() => setFeedback(onAddResearch(entry.id))}><Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />Add to research</Button><p id={`${id}-save-first`} className="mt-2 text-xs text-muted-foreground">{canAddResearch ? 'Adds an attributed note in Develop. Save development when ready.' : 'Save this screenplay first to add research. The reference is available now.'}</p></div>}
          <details key={entry.id} className="border-t border-border pt-3"><summary className="cursor-pointer text-xs font-medium">Caveats & sources</summary><div className="mt-3 space-y-3 text-xs text-muted-foreground">{entry.caveats.length > 0 && <ul className="list-disc space-y-1.5 pl-4">{entry.caveats.map((caveat, index) => <li key={index}>{caveat}</li>)}</ul>}<p>Source links open online in a new tab.</p><ul className="space-y-2">{entry.sources.map((source, index) => <li key={index}><a className="inline-flex items-start gap-1 underline underline-offset-4 hover:text-foreground" href={filmcraftSourceUrl(source) ?? undefined} target="_blank" rel="noopener noreferrer">{filmcraftSourceLabel(source)} · online<ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /></a></li>)}</ul></div></details>
        </article>}
      </div>}
  </section>;
}
