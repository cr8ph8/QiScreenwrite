import { readCharacterCue, readDirectionKind, readSceneHeading } from './screenplay-elements.mjs';
const titleField = /^(?:Title|Credit|Author|Authors|Source|Draft date|Date|Contact|Copyright|Notes):/i;
function headingFor(line) {
    if (line.metadata)
        return null;
    return readSceneHeading(line.visible);
}
function rawLines(text) {
    const lines = [];
    let start = 0, blockEnd = '', titleBlock = true, titleActive = false;
    while (start < text.length) {
        let end = start;
        while (end < text.length && text[end] !== '\r' && text[end] !== '\n')
            end++;
        const fullEnd = end < text.length ? end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1) : end;
        const raw = text.slice(start, end);
        // Only the recognition view masks notes/boneyards. The range keeps every character.
        let visible = '', i = 0;
        while (i < raw.length) {
            if (blockEnd) {
                const close = raw.indexOf(blockEnd, i);
                if (close < 0) {
                    i = raw.length;
                    continue;
                }
                i = close + blockEnd.length;
                blockEnd = '';
                continue;
            }
            if (raw.startsWith('/*', i) || raw.startsWith('[[', i)) {
                blockEnd = raw.startsWith('/*', i) ? '*/' : ']]';
                i += 2;
                continue;
            }
            visible += raw[i++];
        }
        const trimmed = visible.trim();
        const metadata = titleBlock && (titleField.test(trimmed) || titleActive && /^\s+\S/.test(visible));
        if (metadata)
            titleActive = true;
        else if (trimmed) {
            titleBlock = false;
            titleActive = false;
        }
        else
            titleActive = false;
        lines.push({ start, end, fullEnd, raw, visible, number: lines.length + 1, metadata });
        start = fullEnd;
    }
    return lines;
}
function cueObservations(lines) {
    const cues = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i], value = line.visible.trim(), forced = value.startsWith('@');
        if (!value || headingFor(line) || !forced && readDirectionKind(value) || /^[!>#=~[*/]/.test(value))
            continue;
        if (!forced && i > 1 && lines[i - 1].visible.trim())
            continue;
        const cue = readCharacterCue(value, { forced });
        if (!cue)
            continue;
        let nextIndex = i + 1;
        while (nextIndex < lines.length && /^\([^\n]*\)$/.test(lines[nextIndex].visible.trim()))
            nextIndex++;
        const next = lines[nextIndex], nextText = next?.visible.trim();
        // Direction-like words may be the first spoken line after a valid cue.
        // The cue itself was already screened for directions above.
        if (!next || !nextText || headingFor(next) || /^[!>@#=~[*/]/.test(nextText))
            continue;
        cues.push({ name: cue.characterName, extensions: cue.extensions, raw: line.raw, start: line.start, end: line.end, line: line.number });
    }
    return cues;
}
export function buildScreenplayIndex(text) {
    const lines = rawLines(text);
    const headings = lines.flatMap((line, lineIndex) => { const heading = headingFor(line); return heading ? [{ line, lineIndex, ...heading }] : []; });
    const preambleEnd = headings[0]?.line.start ?? text.length;
    const preamble = { start: 0, end: preambleEnd, text: text.slice(0, preambleEnd), startLine: 1, endLine: headings.length ? Math.max(1, headings[0].line.number - 1) : Math.max(1, lines.length) };
    const scenes = headings.map((entry, index) => {
        const next = headings[index + 1], end = next?.line.start ?? text.length;
        const sceneLines = lines.slice(entry.lineIndex, next?.lineIndex ?? lines.length);
        const characterCues = cueObservations(sceneLines);
        return {
            id: `draft-scene-${String(index + 1).padStart(4, '0')}`, index: index + 1,
            start: entry.line.start, end, text: text.slice(entry.line.start, end),
            startLine: entry.line.number, endLine: sceneLines[sceneLines.length - 1].number,
            heading: entry.heading, rawHeading: entry.line.raw, headingStart: entry.line.start, headingEnd: entry.line.end, headingLine: entry.line.number, forced: entry.forced,
            ...(entry.sceneNumber ? { sourceSceneNumber: entry.sceneNumber } : {}),
            characters: [...new Set(characterCues.map(cue => cue.name))], characterCues,
            wordCount: sceneLines.slice(1).reduce((total, line) => total + (line.visible.trim().match(/\S+/gu)?.length ?? 0), 0),
        };
    });
    return { schemaVersion: 1, textLength: text.length, lineCount: lines.length + (!text.length || /[\r\n]$/.test(text) ? 1 : 0), preamble, scenes };
}
/** Validates contiguous ranges while reconstructing the exact supplied string. */
export function reconstructScreenplay(index) {
    let end = 0;
    const text = [index.preamble, ...index.scenes].map(span => {
        if (span.start !== end || span.end < span.start || span.text.length !== span.end - span.start)
            throw new Error('Screenplay ranges are not a lossless contiguous index.');
        end = span.end;
        return span.text;
    }).join('');
    if (end !== index.textLength)
        throw new Error('Screenplay ranges do not cover the complete draft.');
    return text;
}
/** Raw UTF-8 SHA-256, without JSON wrapping or Unicode/newline normalization.
 * Equal duplicate spans share a content hash; bind draft revision + range for identity.
 */
export async function hashScreenplaySpan(span) {
    const bytes = new TextEncoder().encode(span.text);
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== span.text)
        throw new Error('The screenplay span cannot be represented as exact UTF-8.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Positional comparison is deliberately conservative after insertion or reordering.
 * Never collapse equal headings or infer persistent scene identity from their names.
 */
export function classifySceneChanges(current, baseline) {
    return current.scenes.map((scene, index) => !baseline?.scenes[index] ? 'NEW' : scene.text === baseline.scenes[index].text ? 'UNCHANGED' : 'EDITED');
}
/** HTML textareas normalize CRLF/CR; convert a raw UTF-16 offset without changing text. */
export function screenplayOffsetToTextarea(text, offset) {
    const bounded = Math.max(0, Math.min(text.length, Math.trunc(offset)));
    return text.slice(0, bounded).replace(/\r\n/g, '\n').length;
}
/** The editor works against this view so its native caret offsets remain valid. */
export function screenplayTextareaValue(text) { return text.replace(/\r\n|\r/g, '\n'); }
export function textareaOffsetToScreenplay(text, offset) {
    const target = Math.max(0, Math.trunc(offset));
    let raw = 0, visible = 0;
    while (raw < text.length && visible < target) {
        raw += text[raw] === '\r' && text[raw + 1] === '\n' ? 2 : 1;
        visible++;
    }
    return raw;
}
function nearbyLineEnding(text, offset) {
    for (let i = offset - 1; i >= 0; i--) {
        if (text[i] === '\n')
            return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
        if (text[i] === '\r')
            return text[i + 1] === '\n' ? '\r\n' : '\r';
    }
    return text.slice(offset).match(/\r\n|\r|\n/)?.[0] ?? '\n';
}
function joinRawText(left, right) {
    // A formerly separate CR and LF must not merge into one visible line break.
    return left + (left.endsWith('\r') && right.startsWith('\n') ? '\n' : '') + right;
}
/** Apply one editor change to raw authoring text. Unchanged prefix/suffix ranges
 * retain exact bytes. Line breaks within the changed range use the nearest prior
 * line ending (or next one at the beginning of the document; LF for new drafts).
 * This also keeps upstream smart formatting's normalized caret offsets correct.
 */
export function applyScreenplayEditorChange(raw, edited) {
    const previous = screenplayTextareaValue(raw), next = screenplayTextareaValue(edited);
    if (previous === next)
        return raw;
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix])
        suffix++;
    const start = textareaOffsetToScreenplay(raw, prefix), end = textareaOffsetToScreenplay(raw, previous.length - suffix);
    const inserted = next.slice(prefix, next.length - suffix).replace(/\n/g, nearbyLineEnding(raw, start));
    return joinRawText(joinRawText(raw.slice(0, start), inserted), raw.slice(end));
}
