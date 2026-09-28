// Final Draft (.fdx) interchange. Export maps every Fountain element to the
// Final Draft paragraph vocabulary; import maps back to Fountain, keeping
// scene numbers, dual dialogue, notes, emphasis and the title page.
import { readSceneHeading } from "@/lib/screenplay-elements";
import { inlineRuns } from "./inline";
import { parseScreenplay, type Screenplay } from "./spec";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fountain emphasis → styled <Text> runs. */
function runs(text: string): string {
  return inlineRuns(text).map((run) => {
    const style = [run.bold && "Bold", run.italic && "Italic", run.underline && "Underline"].filter(Boolean).join("+");
    return `<Text${style ? ` Style="${style}"` : ""}>${escape(run.text)}</Text>`;
  }).join("") || "<Text></Text>";
}

const paragraph = (type: string, text: string, attributes = "") => {
  const notes = [...text.matchAll(/\[\[([\s\S]*?)\]\]/g)].map((match) => `<ScriptNote><Text>${escape(match[1])}</Text></ScriptNote>`).join("");
  return `    <Paragraph Type="${type}"${attributes}>${runs(text)}${notes}</Paragraph>\n`;
};

export function toFdx(input: string | Screenplay): string {
  const screenplay = typeof input === "string" ? parseScreenplay(input) : input;
  const { blocks } = screenplay;
  let body = "";
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const text = block.text.trim();
    switch (block.type) {
      case "title_page": case "boneyard": continue;
      case "scene_heading": body += paragraph("Scene Heading", text.replace(/^\./, "").replace(/\s+#[\p{L}\p{N}][\p{L}\p{N}._-]*#$/u, ""), block.sceneNumber ? ` Number="${escape(block.sceneNumber)}"` : ""); break;
      case "action": body += paragraph("Action", text.replace(/^!/, "")); break;
      case "lyrics": body += paragraph("Lyrics", text.replace(/^\s*~/gm, "")); break;
      case "centered": body += paragraph("Action", text.replace(/^>\s*/, "").replace(/\s*<$/, ""), ' Alignment="Center"'); break;
      case "transition": body += paragraph("Transition", text.replace(/^>\s*/, "")); break;
      case "page_break": body += `    <Paragraph Type="Action" StartsNewPage="Yes"><Text></Text></Paragraph>\n`; break;
      case "section": body += `    <Paragraph Type="Action"><ScriptNote><Text>${escape(`Section: ${block.plain}`)}</Text></ScriptNote><Text></Text></Paragraph>\n`; break;
      case "synopsis": body += `    <Paragraph Type="Action"><ScriptNote><Text>${escape(`Synopsis: ${block.plain}`)}</Text></ScriptNote><Text></Text></Paragraph>\n`; break;
      case "note": body += `    <Paragraph Type="Action"><ScriptNote><Text>${escape(block.plain)}</Text></ScriptNote><Text></Text></Paragraph>\n`; break;
      case "character": {
        const cue = text.replace(/^@/, "").replace(/\s*\^$/, "");
        let speech = paragraph("Character", cue);
        let next = index + 1;
        while (next < blocks.length && (blocks[next].type === "dialogue" || blocks[next].type === "parenthetical")) {
          speech += paragraph(blocks[next].type === "dialogue" ? "Dialogue" : "Parenthetical", blocks[next].text.trim());
          next++;
        }
        const dualNext = blocks[next]?.type === "character" && blocks[next].character?.dual;
        if (dualNext) {
          let right = paragraph("Character", blocks[next].text.trim().replace(/^@/, "").replace(/\s*\^$/, ""));
          let after = next + 1;
          while (after < blocks.length && (blocks[after].type === "dialogue" || blocks[after].type === "parenthetical")) {
            right += paragraph(blocks[after].type === "dialogue" ? "Dialogue" : "Parenthetical", blocks[after].text.trim());
            after++;
          }
          body += `    <Paragraph><DualDialogue>\n${speech}${right}    </DualDialogue></Paragraph>\n`;
          index = after - 1;
        } else { body += speech; index = next - 1; }
        break;
      }
      case "dialogue": case "parenthetical": body += paragraph(block.type === "dialogue" ? "Dialogue" : "Parenthetical", text); break;
    }
  }
  const titleParagraphs = screenplay.title.map((entry) => {
    // Retain keys and multiline values as one paragraph. FountainKey is an
    // optional round-trip hint; other FDX readers still receive normal text.
    const centered = /^(title|credit|authors?)$/i.test(entry.key);
    const text = centered ? entry.value : `${entry.key}: ${entry.value}`;
    return paragraph("Action", text, ` Alignment="${centered ? "Center" : "Left"}" FountainKey="${escape(entry.key)}"`);
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<FinalDraft DocumentType="Script" Template="No" Version="5">\n  <Content>\n${body}  </Content>\n  <TitlePage>\n    <Content>\n${titleParagraphs}    </Content>\n  </TitlePage>\n</FinalDraft>\n`;
}

function runText(element: Element): string {
  let out = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== 1) continue;
    const node = child as Element;
    if (node.tagName !== "Text") continue;
    const style = (node.getAttribute("Style") ?? "").toLowerCase();
    let text = (node.textContent ?? "").replace(/[\\*_]/g, "\\$&");
    if (!text) continue;
    if (style.includes("underline")) text = `_${text}_`;
    if (style.includes("bold") && style.includes("italic")) text = `***${text}***`;
    else if (style.includes("bold")) text = `**${text}**`;
    else if (style.includes("italic")) text = `*${text}*`;
    out += text;
  }
  return out;
}

export function fromFdx(xml: string): string {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.documentElement.tagName !== "FinalDraft" || document.getElementsByTagName("parsererror").length) throw new Error("This file is not valid Final Draft XML.");
  const content = Array.from(document.getElementsByTagName("Content")).find((node) => node.parentElement?.tagName === "FinalDraft");
  if (!content) throw new Error("This Final Draft file has no script content.");
  const out: string[] = [];
  const emit = (line: string) => { if (out.length && out[out.length - 1] !== "") out.push(""); out.push(line); };
  const speech = (nodes: Element[], dual: boolean) => {
    let first = true;
    for (const node of nodes) {
      const type = node.getAttribute("Type") ?? "";
      const notes = Array.from(node.children).filter((child) => child.tagName === "ScriptNote").map((note) => note.textContent?.trim()).filter(Boolean);
      const text = runText(node).trim() + notes.map((note) => ` [[${note}]]`).join("");
      if (type === "Character") { emit("@" + text + (dual && first ? " ^" : "")); first = false; }
      else if (type === "Parenthetical") out.push(text.startsWith("(") ? text : `(${text})`);
      else if (type === "Dialogue") out.push(text);
    }
  };
  for (const node of Array.from(content.children)) {
    if (node.tagName !== "Paragraph") continue;
    const dual = node.getElementsByTagName("DualDialogue")[0];
    if (dual) {
      const inner = Array.from(dual.children).filter((child) => child.tagName === "Paragraph");
      const cues = inner.map((child, position) => (child.getAttribute("Type") === "Character" ? position : -1)).filter((position) => position >= 0);
      speech(inner.slice(0, cues[1] ?? inner.length), false);
      if (cues[1] !== undefined) speech(inner.slice(cues[1]), true);
      continue;
    }
    const type = node.getAttribute("Type") ?? "Action";
    const notes = Array.from(node.getElementsByTagName("ScriptNote")).map((n) => n.textContent?.trim() ?? "").filter(Boolean);
    let text = runText(node).trim();
    if (["Character", "Dialogue", "Parenthetical"].includes(type)) text += notes.map((note) => ` [[${note}]]`).join("");
    if (node.getAttribute("StartsNewPage") === "Yes" && out.length) { out.push("", "==="); }
    const inlineNotes = ["Character", "Dialogue", "Parenthetical"].includes(type);
    for (const note of inlineNotes ? [] : notes) {
      if (note.startsWith("Section: ")) { out.push("", `# ${note.slice(9)}`); }
      else if (note.startsWith("Synopsis: ")) { out.push("", `= ${note.slice(10)}`); }
      else out.push("", `[[${note}]]`);
    }
    if (!text) continue;
    switch (type) {
      case "Scene Heading": { const number = node.getAttribute("Number"); const heading = text; emit(readSceneHeading(heading) ? heading + (number ? ` #${number}#` : "") : `.${heading}${number ? ` #${number}#` : ""}`); break; }
      case "Character": emit("@" + text); break;
      case "Parenthetical": out.push(text.startsWith("(") ? text : `(${text})`); break;
      case "Dialogue": out.push(text); break;
      case "Transition": emit(`> ${text}`); break;
      case "Lyrics": emit(text.split(/\r\n|\r|\n/).map((line) => `~${line}`).join("\n")); break;
      case "Shot": case "General": emit(`!${text}`); break;
      default: emit(node.getAttribute("Alignment") === "Center" ? `> ${text} <` : `!${text}`);
    }
  }
  const titleContent = document.getElementsByTagName("TitlePage")[0]?.getElementsByTagName("Content")[0];
  const title: string[] = [];
  if (titleContent) {
    const paragraphs = Array.from(titleContent.getElementsByTagName("Paragraph"));
    const hinted = paragraphs.length > 0 && paragraphs.every((p) => p.hasAttribute("FountainKey"));
    const lines = hinted ? [] : paragraphs.map((p) => runText(p).trim()).filter(Boolean);
    if (hinted) for (const p of paragraphs) {
      const key = p.getAttribute("FountainKey")!;
      if (!/^[A-Za-z][A-Za-z ]{0,30}$/.test(key)) throw new Error("Invalid Final Draft title field.");
      const value = runText(p).replace(new RegExp(`^${key}: `, "i"), "");
      title.push(`${key}: ${value.split(/\r\n|\r|\n/).join("\n    ")}`);
    }
    let expectAuthor = false;
    for (const line of lines) {
      const keyed = /^(Contact|Copyright|Notes|Draft date|Date|Revision|Source|Credit|Author|Title):\s*(.*)$/i.exec(line);
      if (keyed) { title.push(`${keyed[1][0].toUpperCase() + keyed[1].slice(1)}: ${keyed[2]}`); continue; }
      if (!title.some((t) => t.startsWith("Title:"))) { title.push(`Title: ${line}`); continue; }
      if (/^(written by|by|screenplay by|story by)$/i.test(line)) { title.push(`Credit: ${line}`); expectAuthor = true; continue; }
      if (expectAuthor) { title.push(`Author: ${line}`); expectAuthor = false; continue; }
      title.push(`Contact: ${line}`);
    }
  }
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return (title.length ? title.join("\n") + "\n\n" : "") + body + "\n";
}
