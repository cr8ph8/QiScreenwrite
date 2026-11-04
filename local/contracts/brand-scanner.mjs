import { buildScreenplayIndex } from './screenplay-index.mjs';

export const BRAND_SCAN_LIMITS = Object.freeze({ opportunities: 200, sourceBytes: 800000 });
function requireBrand(ok, code, status = 422) {
  if (!ok) throw Object.assign(new Error(code), { code, status });
}
const categories = [
  ['beverage', /\b(?:coffee|tea|soda|juice|energy drink|water bottle)\b/gi],
  ['food', /\b(?:sandwich|pizza|takeout|snack|cereal)\b/gi],
  ['technology', /\b(?:laptop|headphones|smartphone|phone|camera|tablet)\b/gi],
  ['vehicle', /\b(?:car|truck|bicycle|motorcycle|van)\b/gi],
  ['wardrobe', /\b(?:jacket|sneakers|boots|backpack|watch)\b/gi],
  ['location', /\b(?:hotel|cafe|café|restaurant|diner)\b/gi],
];

/** Deterministic local suggestions, not valuation, recognition or legal approval.
 * Offsets are UTF-16 positions into the exact saved text. Mask notes/boneyards
 * without moving the offsets; ignore title material outside screenplay scenes. */
export function scanBrandOpportunities(text, source, hash, productionScenes = []) {
  requireBrand(typeof text === 'string' && text.length <= BRAND_SCAN_LIMITS.sourceBytes, 'BRAND_SOURCE_TOO_LARGE', 413);
  const mask = text.replace(/\/\*[\s\S]*?(?:\*\/|$)|\[\[[\s\S]*?(?:\]\]|$)/g, value => value.replace(/[^\r\n]/g, ' '));
  const output = [];
  for (const scene of buildScreenplayIndex(text).scenes) {
    const matches = productionScenes.filter(row => row.heading === scene.heading);
    for (const [category, pattern] of categories) {
      pattern.lastIndex = 0;
      const body = mask.slice(scene.headingEnd, scene.end);
      for (const match of body.matchAll(pattern)) {
        const start = scene.headingEnd + match.index, end = start + match[0].length;
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = text.indexOf('\n', end); if (lineEnd === -1) lineEnd = text.length;
        const opportunity = { source, scriptSceneId: scene.id, productionSceneId: matches.length === 1 ? matches[0].id : null,
          heading: scene.heading, category, start, end, quote: text.slice(start, end),
          context: text.slice(Math.max(lineStart, start - 180), Math.min(lineEnd, end + 180)).trim(),
          reason: `Possible ${category} use in an existing scene. Review narrative fit; no brand or value is inferred.` };
        opportunity.id = `placement:${hash(JSON.stringify([source.fingerprint, scene.id, category, start, end])).slice(0, 40)}`;
        output.push(opportunity);
        if (output.length >= BRAND_SCAN_LIMITS.opportunities) return { opportunities: output, truncated: true };
      }
    }
  }
  output.sort((a, b) => a.start - b.start || a.category.localeCompare(b.category));
  return { opportunities: output, truncated: false };
}
