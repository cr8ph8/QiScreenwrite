import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FILMCRAFT_CATALOG, parseFilmcraftCatalog } from '../filmcraft';

it('ships a valid public reference with category coverage and identical native bytes', () => {
  expect(parseFilmcraftCatalog(FILMCRAFT_CATALOG)).toBe(FILMCRAFT_CATALOG);
  expect(new Set(FILMCRAFT_CATALOG.entries.map(entry => entry.category))).toEqual(new Set(['story', 'image', 'camera', 'editing', 'sound']));
  expect(FILMCRAFT_CATALOG.sources).toEqual([]);
  for (const entry of FILMCRAFT_CATALOG.entries) for (const source of entry.sources) expect(new URL(source.url).hostname).toBe('filmanalysis.yale.edu');
  expect(readFileSync('iphone/QiCanIScreenwrite/Resources/film-language.json').equals(readFileSync('src/local/filmcraft/catalog.json'))).toBe(true);
});
it('rejects corrupt identifiers and unsafe source links instead of inventing definitions', () => {
  const duplicate = structuredClone(FILMCRAFT_CATALOG);
  duplicate.entries[1].id = duplicate.entries[0].id;
  expect(() => parseFilmcraftCatalog(duplicate)).toThrow();
  const unsafe = structuredClone(FILMCRAFT_CATALOG);
  unsafe.entries[0].sources[0].url = 'javascript:alert(1)';
  expect(() => parseFilmcraftCatalog(unsafe)).toThrow();
});
