export interface InlineRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean }

/** Shared display/interchange reader. Protect escapes before interpreting emphasis. */
export function inlineRuns(source: string): InlineRun[] {
  let sentinel = '\uE000';
  while (source.includes(sentinel)) sentinel += '\uE000';
  const literals: string[] = [];
  const protectedText = source.replace(/\\([\\*_])/g, (_, char: string) => {
    literals.push(char);
    return `${sentinel}${literals.length - 1};`;
  }).replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const restore = (text: string) => text.replace(new RegExp(`${sentinel}(\\d+);`, 'g'), (_, index: string) => literals[Number(index)]);
  const parse = (text: string, style: Omit<InlineRun, 'text'> = {}): InlineRun[] => {
    const result: InlineRun[] = [];
    const pattern = /(\*\*\*([\s\S]+?)\*\*\*|\*\*([\s\S]+?)\*\*|\*([^*]+?)\*|_([^_]+?)_)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index! > last) result.push({ text: restore(text.slice(last, match.index)), ...style });
      const inner = match[2] ?? match[3] ?? match[4] ?? match[5];
      const next = match[2] ? { bold: true, italic: true } : match[3] ? { bold: true } : match[4] ? { italic: true } : { underline: true };
      result.push(...parse(inner, { ...style, ...next }));
      last = match.index! + match[0].length;
    }
    if (last < text.length) result.push({ text: restore(text.slice(last)), ...style });
    return result;
  };
  return parse(protectedText);
}
