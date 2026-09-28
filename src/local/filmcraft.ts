import catalogJson from './filmcraft/catalog.json';
import { developmentError, type DevelopmentData, type DevelopmentResearchNote } from './development';

export const FILMCRAFT_CATEGORIES = { story: 'Story', image: 'Image', camera: 'Camera', editing: 'Editing', sound: 'Sound' } as const;
export const FILMCRAFT_KINDS = { term: 'Term', practice: 'Practice', theory: 'Theory', technical: 'Technical' } as const;
export type FilmcraftCategory = keyof typeof FILMCRAFT_CATEGORIES;
export type FilmcraftKind = keyof typeof FILMCRAFT_KINDS;
export interface FilmcraftSource { title: string; url: string; slideNumber?: number }
export interface FilmcraftEntry {
  id: string; title: string; category: FilmcraftCategory; kind: FilmcraftKind;
  definition: string; application: string; prompt: string;
  aliases: string[]; caveats: string[]; sources: FilmcraftSource[];
}
export interface FilmcraftCatalog {
  schema: string; updatedOn: string;
  sources: { id: string; title: string; url: string; slideCount: number }[];
  entries: FilmcraftEntry[];
}
export interface FilmcraftBrowse { query?: string; category?: FilmcraftCategory | 'all'; kind?: FilmcraftKind | 'all' }
export interface FilmcraftResearchRequest { projectId: string; draftId: string; entryId: string }
export interface FilmcraftResearchResult { ok: boolean; message: string }

export function filmcraftSourceLabel(source: FilmcraftSource): string {
  return source.slideNumber && !new RegExp(`\\bslide\\s*#?\\s*${source.slideNumber}\\b`, 'i').test(source.title)
    ? `${source.title} · slide ${source.slideNumber}` : source.title;
}

/** These are links only: browsing/searching the bundled catalog never fetches them. */
export function filmcraftSourceUrl(source: FilmcraftSource): string | null {
  try {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (source.slideNumber && Number.isSafeInteger(source.slideNumber) && source.slideNumber > 0 && !url.hash) {
      url.hash = /\.pdf$/i.test(url.pathname) ? `page=${source.slideNumber}` : String(source.slideNumber);
    }
    return url.href;
  } catch { return null; }
}

/** Validate the supplied package at load time; fail visibly instead of inventing content. */
export function parseFilmcraftCatalog(value: unknown): FilmcraftCatalog {
  const data = value as FilmcraftCatalog;
  const text = (item: unknown): item is string => typeof item === 'string' && !!item.trim();
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(text);
  if (!data || !text(data.schema) || !text(data.updatedOn) || !Array.isArray(data.sources) || !Array.isArray(data.entries)) throw new Error('Film language catalog is invalid.');
  const ids = new Set<string>();
  for (const entry of data.entries) {
    if (!entry || !text(entry.id) || ids.has(entry.id) || !text(entry.title) || !Object.prototype.hasOwnProperty.call(FILMCRAFT_CATEGORIES, entry.category) || !Object.prototype.hasOwnProperty.call(FILMCRAFT_KINDS, entry.kind) || !text(entry.definition) || !text(entry.application) || !text(entry.prompt) || !strings(entry.aliases) || !strings(entry.caveats) || !Array.isArray(entry.sources) || !entry.sources.length || entry.sources.some(source => !source || !text(source.title) || !filmcraftSourceUrl(source) || (source.slideNumber !== undefined && (!Number.isSafeInteger(source.slideNumber) || source.slideNumber < 1)))) throw new Error(`Film language entry is invalid: ${entry?.id ?? 'unknown'}.`);
    ids.add(entry.id);
  }
  if (data.sources.some(source => !source || !text(source.id) || !text(source.title) || !filmcraftSourceUrl(source) || !Number.isSafeInteger(source.slideCount) || source.slideCount < 1)) throw new Error('Film language source list is invalid.');
  return data;
}

export const FILMCRAFT_CATALOG = parseFilmcraftCatalog(catalogJson);
const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function createFilmcraftIndex(entries: readonly FilmcraftEntry[]) {
  return entries.map(entry => ({ entry, names: [entry.title, ...entry.aliases].map(normalize), search: normalize([entry.title, ...entry.aliases, entry.definition, entry.application, entry.prompt, ...entry.caveats].join(' ')) }));
}
const INDEX = createFilmcraftIndex(FILMCRAFT_CATALOG.entries);
export function searchFilmcraft(filters: FilmcraftBrowse = {}, index = INDEX): FilmcraftEntry[] {
  const query = normalize((filters.query ?? '').slice(0, 200));
  const words = query.split(' ').filter(Boolean);
  return index.filter(({ entry, search }) => (!filters.category || filters.category === 'all' || entry.category === filters.category) && (!filters.kind || filters.kind === 'all' || entry.kind === filters.kind) && words.every(word => search.includes(word)))
    .sort((a, b) => Number(b.names.includes(query)) - Number(a.names.includes(query)) || a.entry.title.localeCompare(b.entry.title))
    .map(item => item.entry);
}

export function filmcraftResearchNote(entry: FilmcraftEntry): DevelopmentResearchNote {
  return {
    id: crypto.randomUUID(), title: entry.title,
    notes: [`Film language reference: ${entry.title}`, entry.definition, `Application\n${entry.application}`, `Writing prompt\n${entry.prompt}`, ...(entry.caveats.length ? [`Caveats\n${entry.caveats.map(text => `• ${text}`).join('\n')}`] : [])].join('\n\n'),
    source: [`Bundled film language · ${entry.id}`, ...entry.sources.map(source => `${filmcraftSourceLabel(source)}\n${filmcraftSourceUrl(source) ?? source.url}`)].join('\n\n'),
  };
}

/** Append a separate attributed note, preserving every existing field verbatim. */
export function appendFilmcraftResearch(data: DevelopmentData, entry: FilmcraftEntry): { data: DevelopmentData; added: boolean; error: string | null } {
  const note = filmcraftResearchNote(entry);
  if (data.researchNotes.some(item => item.title === note.title && item.notes === note.notes && item.source === note.source)) return { data, added: false, error: null };
  const next = { ...data, researchNotes: [...data.researchNotes, note] };
  const error = developmentError(next, data.projectId, data.draftId);
  return { data: error ? data : next, added: !error, error };
}
