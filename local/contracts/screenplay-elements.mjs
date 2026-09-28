const descriptions = {
    scene_heading: ['Scene heading', 'The location and time of a scene. Printed scene numbers are separate from scene order.'],
    action: ['Action', 'What can be seen or heard; linked production interpretations remain separate.'],
    character: ['Character cue', 'Who speaks next. Voice and continuation extensions belong to this cue, not a new character.'],
    dialogue: ['Dialogue', 'The words spoken by the character.'],
    parenthetical: ['Parenthetical', 'A brief delivery or performance note within a dialogue block.'],
    transition: ['Transition', 'An opening, closing or editing direction.'],
    intercut: ['Intercut', 'A direction to alternate between locations or actions; the relationships need explicit planning.'],
    subheader: ['Subheader', 'A possible smaller setting within a scene. A short location label is an interpretation to review.'],
    shot: ['Shot direction', 'An explicit viewpoint, framing or camera instruction in the writing, not an approved production shot.'],
    lyrics: ['Lyrics', 'Words marked as sung.'],
    general: ['General text', 'Retained text without a more specific supported page-element classification.'],
    empty: ['Blank line', 'Spacing retained in the original screenplay.'],
};
const standardHeading = /^(?:(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT|EST|I\s*\/\s*E)\.)(?:\s+|(?=[^\p{L}\p{N}]))\S.*$/iu;
export function readSceneHeading(text) {
    const trimmed = text.trim(), forced = /^\.(?![.\s])\S/.test(trimmed);
    if (!forced && !standardHeading.test(trimmed))
        return null;
    const visible = forced ? trimmed.slice(1) : trimmed;
    const number = visible.match(/\s+#([\p{L}\p{N}][\p{L}\p{N}._-]*)#\s*$/u);
    return { heading: number ? visible.slice(0, number.index).trimEnd() : visible, ...(number ? { sceneNumber: number[1] } : {}), forced };
}
/** These forms are intentionally bounded. An unmarked arbitrary place name
 * cannot reliably be distinguished from a character without author review. */
export function readDirectionKind(text) {
    const value = text.trim();
    if (/^>(?!.*<\s*$)\s*\S/.test(value) || /^(?:FADE (?:IN\s*:?|OUT[.:]?|TO BLACK[.:]?)|CUT TO BLACK[.:]?|THE END)$/i.test(value) || /^(?:[A-Z][A-Z\s-]* )?TO:$/.test(value))
        return 'transition';
    if (/^INTERCUT(?:\s*[-:]|\s+(?:BETWEEN|WITH)\b|$)/i.test(value))
        return 'intercut';
    if (/^(?:(?:[\p{L}\p{N} .’'-]+['’]S\s+)?P\.?O\.?V\.?)(?:\s*[-:]|\s+|$)/iu.test(value) || /^(?:(?:EXTREME\s+)?CLOSE[ -]UP|MEDIUM SHOT|WIDE SHOT|ESTABLISHING SHOT|ANGLE ON|CAMERA (?:PANS?|TILTS?|TRACKS?|MOVES?|PULLS?)|INSERT|IN SLOW MOTION)(?:\s*[-:]|\s+|$)/i.test(value))
        return 'shot';
    if (/^(?:SUBHEADER|MINI[- ]SLUG)\s*:\s*\S/i.test(value) || /^(?:STAIRWELL|HALLWAY|CORRIDOR|KITCHEN|BEDROOM|BATHROOM|LIVING ROOM|LAMP ROOM|ROOFTOP|BASEMENT|ATTIC)$/.test(value))
        return 'subheader';
    return null;
}
export function readCharacterCue(text, options = {}) {
    const trimmed = text.trim(), forced = options.forced || trimmed.startsWith('@');
    if (!forced && (readSceneHeading(trimmed) || readDirectionKind(trimmed) || /^[!>#=~[*/]/.test(trimmed)))
        return null;
    let name = (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).replace(/\s*\^$/, '').trim();
    const extensions = [];
    let suffix;
    while ((suffix = name.match(/\s*\(([^()\n]+)\)\s*$/))) {
        extensions.unshift(suffix[1].trim());
        name = name.slice(0, suffix.index).trim();
    }
    if (!name || name.length > 80 || (!forced && (!/^[\p{Lu}\p{Lt}\p{N}\p{M} .,'’-]+$/u.test(name) || !/[\p{Lu}\p{Lt}]/u.test(name))))
        return null;
    return { characterName: name, extensions };
}
export function readPageElement(text, declaredType) {
    const value = text.trim();
    const declared = declaredType?.trim().toLowerCase().replace(/[ -]+/g, '_');
    const result = (kind, inferred = false) => ({ kind, label: descriptions[kind][0], description: descriptions[kind][1], ...(inferred ? { inferred: true } : {}) });
    if (!value)
        return result('empty');
    const heading = readSceneHeading(value);
    if (declared && declared !== 'action' && declared !== 'general') {
        if (!Object.prototype.hasOwnProperty.call(descriptions, declared))
            return { ...result('general'), description: `Original paragraph type “${declaredType}” is retained; it has no dedicated page-element interpretation.` };
        const reading = result(declared);
        if (declared === 'character')
            Object.assign(reading, readCharacterCue(value, { forced: true }) ?? {});
        if (declared === 'scene_heading' && heading?.sceneNumber)
            reading.sceneNumber = heading.sceneNumber;
        return reading;
    }
    // Explicit Fountain force markers override heuristics in authored text.
    if (!declared && value.startsWith('!'))
        return result('action');
    if (!declared && value.startsWith('@'))
        return { ...result('character'), ...(readCharacterCue(value, { forced: true }) ?? {}) };
    if (!declared && heading)
        return { ...result('scene_heading', !heading.forced), ...(heading.sceneNumber ? { sceneNumber: heading.sceneNumber } : {}) };
    if (!declared && value.startsWith('~'))
        return result('lyrics');
    const direction = readDirectionKind(value);
    if (direction)
        return result(direction, true);
    if (!declared && /^\([^\n]*\)$/.test(value))
        return result('parenthetical', true);
    const cue = !declared ? readCharacterCue(value) : null;
    if (cue)
        return { ...result('character', true), ...cue };
    return result(declared === 'general' ? 'general' : 'action', !declared);
}
