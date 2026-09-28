// Word export with screenplay indents (Courier New 12, 1.5"/1" margins) so a
// script opens correctly formatted in Word, Pages or Google Docs.
import { AlignmentType, Document, Packer, Paragraph, TextRun, LineRuleType } from "docx";
import { paginate, type PageLine } from "./paginate";
import { parseScreenplay } from "./spec";

const TWIP = 1440;
const colTwips = (col: number) => Math.round(col * TWIP / 10);

function paragraphFor(line: PageLine, pageBreakBefore = false): Paragraph {
  const alignment = line.align === "right" ? AlignmentType.RIGHT : line.align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
  const bold = line.type === "scene_heading";
  const children = [new TextRun({ text: line.dual ? line.text.padEnd(line.dual.col - line.col) + line.dual.text : line.text, font: "Courier New", size: 24, bold })];
  return new Paragraph({ children, alignment, pageBreakBefore, widowControl: false, spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.EXACT }, indent: line.align === "left" ? { left: colTwips(line.col), right: line.dual ? 0 : colTwips(Math.max(0, 60 - line.col - line.width)) } : undefined });
}

export async function buildScreenplayDocx(text: string, options: { sceneNumbers?: boolean } = {}): Promise<Blob> {
  const screenplay = parseScreenplay(text);
  const pages = paginate(screenplay, options);
  const children: Paragraph[] = [];
  if (screenplay.title.length) {
    const get = (key: string) => screenplay.title.filter((entry) => entry.key.toLowerCase() === key || (key === "author" && entry.key.toLowerCase() === "authors") || (key === "draft date" && entry.key.toLowerCase() === "date")).map((entry) => entry.value).join("\n");
    for (let n = 0; n < 16; n++) children.push(new Paragraph({ children: [new TextRun({ text: "", font: "Courier New", size: 24 })] }));
    for (const [key, transform] of [["title", (v: string) => v.toUpperCase()], ["credit", (v: string) => v], ["author", (v: string) => v], ["source", (v: string) => v]] as const) {
      const value = get(key);
      if (!value) continue;
      for (const line of transform(value).split("\n")) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: line, font: "Courier New", size: 24 })] }));
      children.push(new Paragraph({ children: [new TextRun({ text: "", font: "Courier New", size: 24 })] }));
    }
    for (const key of ["draft date", "revision", "contact", "copyright", "notes"]) { const value = get(key); if (value) for (const line of value.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line, font: "Courier New", size: 24 })] })); }
  }
  pages.forEach((page, index) => {
    page.lines.forEach((line, lineIndex) => children.push(paragraphFor({ ...line, text: line.sceneNumber && options.sceneNumbers !== false ? `${line.sceneNumber}  ${line.text}` : line.text }, lineIndex === 0 && (index > 0 || screenplay.title.length > 0))));
  });
  const document = new Document({
    styles: { default: { document: { run: { font: "Courier New", size: 24 } } } },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: TWIP, bottom: TWIP, left: Math.round(1.5 * TWIP), right: TWIP } } }, children }],
  });
  return Packer.toBlob(document);
}
