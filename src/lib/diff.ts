/**
 * Line-based diff with optional inline word-level highlighting.
 */
export interface DiffLine {
  type: "equal" | "add" | "remove";
  text: string;
}

/** A word-level segment within a changed line */
export interface WordSegment {
  type: "equal" | "add" | "remove";
  text: string;
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  let i = m, j = n;
  const stack: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "equal", text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }

  stack.reverse();
  return stack;
}

/**
 * Word-level diff between two strings.
 * Splits on word boundaries and computes LCS to produce segments.
 */
export function computeWordDiff(oldLine: string, newLine: string): WordSegment[] {
  const oldWords = tokenize(oldLine);
  const newWords = tokenize(newLine);

  const m = oldWords.length;
  const n = newWords.length;

  // LCS on words
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  let i = m, j = n;
  const stack: WordSegment[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      stack.push({ type: "equal", text: oldWords[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", text: newWords[j - 1] });
      j--;
    } else {
      stack.push({ type: "remove", text: oldWords[i - 1] });
      i--;
    }
  }

  stack.reverse();

  // Merge consecutive segments of same type
  const merged: WordSegment[] = [];
  for (const seg of stack) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** Tokenize preserving whitespace so we can reconstruct the line exactly */
function tokenize(line: string): string[] {
  return line.match(/\S+|\s+/g) || [];
}
