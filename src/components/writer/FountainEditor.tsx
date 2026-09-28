import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight Fountain editor with syntax highlighting + smart formatting.
 *
 * Technique: a transparent <textarea> sits on top of a styled <pre> "mirror".
 * Both share the exact same font metrics + padding + line-height so the
 * highlighted text underneath aligns perfectly with the caret + typed text.
 */

type LineKind =
  | "scene_heading"
  | "character"
  | "parenthetical"
  | "dialogue"
  | "action"
  | "transition"
  | "section"
  | "empty";

const SCENE_HEADING_RE = /^(INT\.|EXT\.|EST\.|INT\/EXT\.|I\/E\.)[\s.]*.+/i;
const TRANSITION_RE = /^(FADE IN:|FADE OUT\.|FADE TO:|CUT TO:|SMASH CUT TO:|MATCH CUT TO:|DISSOLVE TO:|IRIS IN:|IRIS OUT:)$/i;
const CHARACTER_RE = /^[A-Z][A-Z0-9 \-'.]+(\s*\(.*\))?$/;
const PARENTHETICAL_RE = /^\(.*\)$/;
const SECTION_RE = /^#{1,6}\s+/;
const SCENE_PREFIX_LOWER_RE = /^(int|ext|est|int\/ext|i\/e)[.\s]/i;

function classifyLines(text: string): LineKind[] {
  const lines = text.split("\n");
  const kinds: LineKind[] = [];
  let lastWasCharacter = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") {
      kinds.push("empty");
      lastWasCharacter = false;
      continue;
    }
    if (SECTION_RE.test(trimmed)) {
      kinds.push("section");
      lastWasCharacter = false;
      continue;
    }
    if (SCENE_HEADING_RE.test(trimmed)) {
      kinds.push("scene_heading");
      lastWasCharacter = false;
      continue;
    }
    if (TRANSITION_RE.test(trimmed)) {
      kinds.push("transition");
      lastWasCharacter = false;
      continue;
    }
    if (PARENTHETICAL_RE.test(trimmed) && lastWasCharacter) {
      kinds.push("parenthetical");
      // stay in dialogue
      continue;
    }
    if (
      CHARACTER_RE.test(trimmed) &&
      trimmed.length > 1 &&
      trimmed.length < 60
    ) {
      // Only treat as character if next non-empty line exists
      let next = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== "") {
          next = lines[j].trim();
          break;
        }
      }
      if (next) {
        kinds.push("character");
        lastWasCharacter = true;
        continue;
      }
    }
    if (lastWasCharacter) {
      kinds.push("dialogue");
      continue;
    }
    kinds.push("action");
    lastWasCharacter = false;
  }
  return kinds;
}

const KIND_CLASS: Record<LineKind, string> = {
  scene_heading: "text-primary font-semibold uppercase tracking-wide",
  character: "text-amber-300 uppercase",
  parenthetical: "text-muted-foreground italic",
  dialogue: "text-foreground/90",
  action: "text-foreground/75",
  transition: "text-primary/90 uppercase",
  section: "text-primary/60 font-semibold",
  empty: "",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface FountainEditorHandle {
  focus: () => void;
  getTextarea: () => HTMLTextAreaElement | null;
  insertAtCursor: (text: string) => void;
}

interface FountainEditorProps {
  value: string;
  onChange: (next: string, composing?: boolean) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  ariaLabel?: string;
  disabled?: boolean;
  smartFormatting?: boolean;
  onEditorKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelectionChange?: (start: number, end: number) => void;
}

export const FountainEditor = forwardRef<FountainEditorHandle, FountainEditorProps>(
  function FountainEditor({ value, onChange, placeholder, className, minHeight = 600, ariaLabel, disabled = false, smartFormatting = true, onEditorKeyDown, onSelectionChange }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mirrorRef = useRef<HTMLPreElement>(null);
    const composing = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      getTextarea: () => textareaRef.current,
      insertAtCursor: (text: string) => {
        const ta = textareaRef.current;
        if (!ta) {
          onChange(value + (value.endsWith("\n") || value === "" ? "" : "\n") + text);
          return;
        }
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const pad =
          before.length > 0 && !before.endsWith("\n\n")
            ? before.endsWith("\n")
              ? "\n"
              : "\n\n"
            : "";
        const next = before + pad + text + "\n" + after;
        onChange(next);
        requestAnimationFrame(() => {
          ta.focus();
          const pos = before.length + pad.length + text.length + 1;
          ta.setSelectionRange(pos, pos);
        });
      },
    }));

    const kinds = useMemo(() => classifyLines(value), [value]);

    const highlightedHtml = useMemo(() => {
      const lines = value.split("\n");
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const k = kinds[i] ?? "action";
        const cls = KIND_CLASS[k];
        // Pad empty lines with a zero-width space so line height matches
        const content = lines[i] === "" ? "\u200B" : escapeHtml(lines[i]);
        out.push(`<span class="${cls}">${content}</span>`);
      }
      return out.join("\n");
    }, [value, kinds]);

    // Sync scroll between textarea and mirror
    const handleScroll = useCallback(() => {
      const ta = textareaRef.current;
      const mirror = mirrorRef.current;
      if (!ta || !mirror) return;
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }, []);

    // Smart formatting on key events
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        onEditorKeyDown?.(e);
        if (e.defaultPrevented || !smartFormatting || e.nativeEvent.isComposing || disabled) return;
        const ta = e.currentTarget;
        const pos = ta.selectionStart;

        // Tab cycles line type when caret is on a non-empty line
        if (e.key === "Tab") {
          e.preventDefault();
          const before = value.slice(0, pos);
          const after = value.slice(ta.selectionEnd);
          const lineStart = before.lastIndexOf("\n") + 1;
          const lineEndRel = after.indexOf("\n");
          const lineEnd = lineEndRel === -1 ? value.length : pos + lineEndRel;
          const line = value.slice(lineStart, lineEnd);
          const trimmed = line.trim();

          let next = line;
          if (trimmed === "") {
            // Insert scene heading template
            next = "INT. ";
          } else if (PARENTHETICAL_RE.test(trimmed)) {
            // parenthetical → dialogue (strip parens)
            next = trimmed.slice(1, -1);
          } else if (trimmed === trimmed.toUpperCase()) {
            // already caps (character/scene/transition) → wrap in parens
            next = `(${trimmed.toLowerCase()})`;
          } else {
            // action/dialogue → uppercase (character cue)
            next = trimmed.toUpperCase();
          }

          const newValue = value.slice(0, lineStart) + next + value.slice(lineEnd);
          onChange(newValue);
          requestAnimationFrame(() => {
            const caret = lineStart + next.length;
            ta.setSelectionRange(caret, caret);
          });
          return;
        }

        // Enter: auto-uppercase scene headings + character cues
        if (e.key === "Enter") {
          const before = value.slice(0, pos);
          const after = value.slice(ta.selectionEnd);
          const lineStart = before.lastIndexOf("\n") + 1;
          const line = before.slice(lineStart);
          const trimmed = line.trim();

          // Scene heading auto-caps
          if (SCENE_PREFIX_LOWER_RE.test(trimmed) && trimmed !== trimmed.toUpperCase()) {
            e.preventDefault();
            const upper = trimmed.toUpperCase();
            const newValue =
              value.slice(0, lineStart) + upper + "\n" + after;
            onChange(newValue);
            requestAnimationFrame(() => {
              const caret = lineStart + upper.length + 1;
              ta.setSelectionRange(caret, caret);
            });
            return;
          }

          // Character cue heuristic: short single-word-ish line, no caps yet,
          // followed by us pressing Enter → upcase + add blank line for dialogue
          if (
            trimmed.length > 1 &&
            trimmed.length < 40 &&
            /^[A-Za-z][A-Za-z0-9 \-'.]*$/.test(trimmed) &&
            trimmed !== trimmed.toUpperCase() &&
            // Heuristic: previous line is empty (character cues sit between blanks)
            (lineStart === 0 || value[lineStart - 2] === "\n")
          ) {
            // Only trigger if the line looks like a name (no sentence punctuation)
            if (!/[.!?,]$/.test(trimmed)) {
              e.preventDefault();
              const upper = trimmed.toUpperCase();
              const newValue =
                value.slice(0, lineStart) + upper + "\n" + after;
              onChange(newValue);
              requestAnimationFrame(() => {
                const caret = lineStart + upper.length + 1;
                ta.setSelectionRange(caret, caret);
              });
              return;
            }
          }
        }
      },
      [value, onChange, onEditorKeyDown, smartFormatting, disabled]
    );

    // Resync scroll when value changes (e.g. programmatic insert)
    useEffect(() => {
      handleScroll();
    }, [value, handleScroll]);

    return (
      <div
        className={cn("relative w-full font-mono text-sm leading-6", className)}
        style={{ minHeight }}
      >
        {smartFormatting && <pre
          ref={mirrorRef}
          aria-hidden
          className="absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-input bg-background px-3 py-2 pointer-events-none"
          // dangerouslySetInnerHTML is safe: we escape every line above
          dangerouslySetInnerHTML={{ __html: highlightedHtml + "\n" }}
          style={{
            font: "inherit",
            lineHeight: "inherit",
          }}
        />}
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          disabled={disabled}
          onSelect={event => onSelectionChange?.(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
          value={value}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onChange={(e) => onChange(e.target.value, composing.current)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck
          className={cn("relative w-full h-full resize-none rounded-md border border-input bg-transparent px-3 py-2 outline-none focus:ring-2 focus:ring-ring caret-foreground selection:bg-primary/30 whitespace-pre-wrap break-words placeholder:text-muted-foreground/60", smartFormatting ? "text-transparent selection:text-transparent" : "text-foreground")}
          style={{
            font: "inherit",
            lineHeight: "inherit",
            minHeight,
          }}
        />
      </div>
    );
  }
);
