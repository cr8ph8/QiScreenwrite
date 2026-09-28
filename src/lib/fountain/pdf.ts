// Industry-layout PDF: US Letter, Courier 12pt, 1.5" left / 1" right, top and
// bottom margins, page numbers from page 2, optional scene numbers in both
// margins, optional revision asterisks in the right margin, and a title page.
import { jsPDF } from "jspdf";
import { paginate, type Page, type PaginateOptions } from "./paginate";
import { parseScreenplay, type Screenplay } from "./spec";

const PT_PER_COL = 7.2; // Courier 12pt at 10 cpi
const LEFT = 108; // 1.5"
const TOP = 72; // 1"
const LINE = 12; // 6 lines per inch
const PAGE_W = 612, PAGE_H = 792;

export interface PdfOptions extends PaginateOptions {
  titlePage?: boolean;
  /** Block indexes whose lines carry a revision mark. */
  revisedBlocks?: Set<number>;
  revisionLabel?: string;
  watermark?: string;
}

function drawTitlePage(doc: jsPDF, screenplay: Screenplay) {
  const get = (key: string) => screenplay.title.find((entry) => entry.key.toLowerCase() === key)?.value ?? "";
  const centered = (text: string, y: number) => { for (const line of text.split("\n")) { doc.text(line, PAGE_W / 2, y, { align: "center" }); y += LINE; } return y; };
  let y = PAGE_H * 0.38;
  y = centered(get("title").toUpperCase(), y) + LINE * 2;
  if (get("credit")) y = centered(get("credit"), y) + LINE;
  const author = get("author") || get("authors");
  if (author) y = centered(author, y) + LINE;
  if (get("source")) y = centered(get("source"), y) + LINE;
  let bottom = PAGE_H - TOP - LINE * 6;
  for (const key of ["draft date", "date", "revision", "copyright", "contact"]) {
    const value = get(key);
    if (!value) continue;
    for (const line of value.split("\n")) { doc.text(line, LEFT, bottom); bottom += LINE; }
  }
  if (get("notes")) { bottom += LINE; for (const line of get("notes").split("\n")) { doc.text(line, LEFT, bottom); bottom += LINE; } }
}

export function renderPages(doc: jsPDF, pages: Page[], options: PdfOptions = {}) {
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0 || options.titlePage) doc.addPage();
    if (page.number > 1) doc.text(`${page.number}.`, LEFT + 60 * PT_PER_COL, 36, { align: "right" });
    if (options.revisionLabel) { doc.setFontSize(9); doc.text(options.revisionLabel, LEFT, 36); doc.setFontSize(12); }
    if (options.watermark) { doc.saveGraphicsState(); doc.setTextColor(200); doc.setFontSize(48); doc.text(options.watermark, PAGE_W / 2, PAGE_H / 2, { align: "center", angle: 35 }); doc.restoreGraphicsState(); doc.setTextColor(0); doc.setFontSize(12); }
    let y = TOP + LINE;
    for (const line of page.lines) {
      const draw = (text: string, col: number, width: number, align: "left" | "right" | "center") => {
        if (!text) return;
        const x = align === "right" ? LEFT + (col + width) * PT_PER_COL : align === "center" ? LEFT + (col + width / 2) * PT_PER_COL : LEFT + col * PT_PER_COL;
        doc.text(text, x, y, { align });
      };
      draw(line.text, line.col, line.width, line.align);
      if (line.dual) draw(line.dual.text, line.dual.col, line.dual.width, "left");
      if (line.sceneNumber && options.sceneNumbers !== false) { doc.text(line.sceneNumber, LEFT - 5 * PT_PER_COL, y); doc.text(line.sceneNumber, LEFT + 62 * PT_PER_COL, y); }
      if (options.revisedBlocks && line.blockIndex !== undefined && options.revisedBlocks.has(line.blockIndex)) doc.text("*", LEFT + 61.5 * PT_PER_COL, y);
      y += LINE;
    }
  });
}

export function buildScreenplayPdf(text: string, options: PdfOptions = {}): jsPDF {
  const screenplay = parseScreenplay(text);
  const pages = paginate(screenplay, options);
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  doc.setFont("courier", "normal"); doc.setFontSize(12);
  const withTitle = options.titlePage ?? screenplay.title.length > 0;
  if (withTitle) drawTitlePage(doc, screenplay);
  renderPages(doc, pages, { ...options, titlePage: withTitle });
  return doc;
}

export function exportScreenplayPdf(text: string, filename: string, options: PdfOptions = {}) {
  buildScreenplayPdf(text, options).save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
