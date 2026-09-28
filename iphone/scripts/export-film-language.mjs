#!/usr/bin/env node
// Bundle the same offline catalog imported by src/local/filmcraft.ts.
// Copy bytes, not a projection: preserve every definition, alias, caveat and source.
// Run from any directory; --check verifies without writing. No network access.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../../src/local/filmcraft/catalog.json', import.meta.url);
const destination = new URL('../QiCanIScreenwrite/Resources/film-language.json', import.meta.url);
const argumentsList = process.argv.slice(2);
if (argumentsList.some(argument => argument !== '--check')) {
  throw new Error('Usage: node iphone/scripts/export-film-language.mjs [--check]');
}
const bytes = await readFile(source);
const catalog = JSON.parse(bytes.toString('utf8'));
const categories = new Set(['story', 'image', 'camera', 'editing', 'sound']);
const kinds = new Set(['term', 'practice', 'theory', 'technical']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const safeURL = value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};
const validSource = source => source && nonempty(source.title) && safeURL(source.url)
  && (source.slideNumber === undefined || Number.isSafeInteger(source.slideNumber) && source.slideNumber > 0);
if (catalog.schema !== 'caniscreenwrite-filmcraft-catalog/v1' || !nonempty(catalog.updatedOn)
    || !Array.isArray(catalog.entries) || !catalog.entries.length || !Array.isArray(catalog.sources)) {
  throw new Error('Invalid offline film language catalog header.');
}
const ids = new Set();
for (const entry of catalog.entries) {
  if (!entry || !nonempty(entry.id) || ids.has(entry.id) || !nonempty(entry.title)
      || !categories.has(entry.category) || !kinds.has(entry.kind)
      || !['definition', 'application', 'prompt'].every(key => nonempty(entry[key]))
      || !['aliases', 'caveats'].every(key => Array.isArray(entry[key]) && entry[key].every(nonempty))
      || !Array.isArray(entry.sources) || !entry.sources.length || !entry.sources.every(validSource)) {
    throw new Error(`Invalid film language entry: ${entry?.id ?? 'unknown'}`);
  }
  ids.add(entry.id);
}
const sourceIDs = new Set();
for (const source of catalog.sources) {
  if (!validSource(source) || !nonempty(source.id) || sourceIDs.has(source.id)
      || !Number.isSafeInteger(source.slideCount) || source.slideCount < 1) {
    throw new Error('Invalid film language source index.');
  }
  sourceIDs.add(source.id);
}
if (argumentsList.includes('--check')) {
  const existing = await readFile(destination);
  if (!existing.equals(bytes)) throw new Error('Bundled film-language.json is stale. Run this script without --check.');
  console.log(`Verified ${catalog.entries.length} entries and ${catalog.sources.length} source decks; bundle matches desktop byte for byte.`);
} else {
  await mkdir(new URL('.', destination), { recursive: true });
  await writeFile(destination, bytes);
  console.log(`Bundled ${catalog.entries.length} entries in ${fileURLToPath(destination)}`);
}
