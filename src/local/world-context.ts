import type { Screenplay } from '@/lib/fountain/spec';
import type { WorldLink } from './world';

export interface WorldTarget { ref: string; label: string; offset?: number }
export interface WorldContext { scenes: WorldTarget[]; characters: WorldTarget[]; locations: string[]; ambiguousScenes: number }

/** Never bind a link by row position: moving scenes must not change its subject.
 * These are current-parse references, not persistent identities: a reused unique
 * heading/number or exact cue name can resolve again after its original is gone. */
export function worldContext(screenplay: Screenplay): WorldContext {
  const numbers = new Map<string, number>(), headings = new Map<string, number>();
  screenplay.scenes.forEach(scene => {
    if (scene.sceneNumber) numbers.set(scene.sceneNumber, (numbers.get(scene.sceneNumber) ?? 0) + 1);
    headings.set(scene.heading, (headings.get(scene.heading) ?? 0) + 1);
  });
  const scenes: WorldTarget[] = [];
  screenplay.scenes.forEach(scene => {
    const ref = scene.sceneNumber && numbers.get(scene.sceneNumber) === 1 ? `number:${scene.sceneNumber}`
      : headings.get(scene.heading) === 1 ? `heading:${scene.heading}` : null;
    if (ref && ref.length <= 500 && scene.heading.length <= 500) scenes.push({ ref, label: scene.heading, offset: scene.start });
  });
  const firstCues = new Map<string, number>();
  for (const block of screenplay.blocks) {
    // Use the parser's exact cue name and source offset, never a prose/name search.
    if (block.type === 'character' && block.character && block.character.name.length <= 500 && !firstCues.has(block.character.name)) firstCues.set(block.character.name, block.start);
  }
  const characters = [...firstCues.keys()].sort().map(name => ({ ref: name, label: name, offset: firstCues.get(name)! }));
  return { scenes, characters, locations: [...new Set(screenplay.scenes.map(scene => scene.location).filter(Boolean))].sort(), ambiguousScenes: screenplay.scenes.length - scenes.length };
}

export function resolveWorldLink(link: WorldLink, context: WorldContext): WorldTarget | undefined {
  if (link.targetType === 'element') return undefined;
  // Numbered scenes can keep their number while being completely replaced.
  // Require the recorded heading too, and ask the author to relink changes.
  return context[link.targetType === 'scene' ? 'scenes' : 'characters'].find(target => target.ref === link.targetRef && target.label === link.targetLabel);
}
