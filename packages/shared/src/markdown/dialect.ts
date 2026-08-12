import type { MarkdownDialectDetection, UnsupportedFeature } from "./types.js";

const fencePattern = /^ {0,3}(`{3,}|~{3,})/;
const headingPattern = /^ {0,3}(#{1,6})(?:\s+|$)/;
const listPattern = /^ {0,3}(?:[-+*]|\d+[.)])\s+/;
const htmlPattern = /<\/?[A-Za-z][^>]*>|<!--|<![A-Z]/;
const linkPattern = /\[[^\]]+\]\(/;

function addFeature(features: UnsupportedFeature[], feature: UnsupportedFeature): void {
  if (!features.some((existing) => existing.code === feature.code && existing.line === feature.line)) {
    features.push(feature);
  }
}

/**
 * Detect the intentionally small Markdown dialect accepted by the visual editor.
 * Detection runs before parsing so unsupported syntax cannot be normalized by
 * accident. The original source is retained by the source-mode fallback.
 */
export function detectMarkdownDialect(source: string): MarkdownDialectDetection {
  const features: UnsupportedFeature[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const fence = line.match(fencePattern);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1] ?? "";
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      addFeature(features, { code: "fenced-code", message: "Fenced code blocks use source mode.", line: lineNumber });
      continue;
    }
    if (inFence) continue;

    if (/\s{2,}$/.test(line)) {
      addFeature(features, { code: "hard-break", message: "Hard line breaks use source mode.", line: lineNumber });
    }
    if (/^\s{4,}\S/.test(line)) {
      addFeature(features, { code: "indented-code", message: "Indented code uses source mode.", line: lineNumber });
    }
    if (htmlPattern.test(line)) {
      addFeature(features, { code: "raw-html", message: "Raw HTML uses source mode.", line: lineNumber });
    }
    if (/!\[[^\]]*\]\(/.test(line)) {
      addFeature(features, { code: "image", message: "Images use source mode until an image policy is defined.", line: lineNumber });
    }
    if (/^\s*\[[^\]]+\]:\s*/.test(line)) {
      addFeature(features, { code: "reference-definition", message: "Reference definitions use source mode.", line: lineNumber });
    }
    if (/^\s*\[\^[^\]]+\]/.test(line) || /\[\^[^\]]+\]/.test(line)) {
      addFeature(features, { code: "footnote", message: "Footnotes use source mode.", line: lineNumber });
    }
    if (/^ {0,3}[-+*]\s+\[[ xX]\]\s+/.test(line)) {
      addFeature(features, { code: "task-list", message: "Task list items use source mode.", line: lineNumber });
    }
    if (/^ {0,3}(?:([-*_])\s*){3,}$/.test(line)) {
      addFeature(features, { code: "thematic-break", message: "Thematic breaks use source mode.", line: lineNumber });
    }
    if (/^ {0,3}(?:=+|-+)\s*$/.test(line) && index > 0 && (lines[index - 1] ?? "").trim() !== "") {
      addFeature(features, { code: "setext-heading", message: "Setext headings use source mode.", line: lineNumber });
    }
    if (/~~[^\n]*~~/.test(line)) {
      addFeature(features, { code: "strike-through", message: "Strike-through uses source mode.", line: lineNumber });
    }
    if (/`[^`]*`/.test(line)) {
      addFeature(features, { code: "inline-code", message: "Inline code uses source mode.", line: lineNumber });
    }
    if (/^ {0,3}#{1,6}\S/.test(line)) {
      addFeature(features, { code: "unsupported-heading", message: "ATX headings require a space after #.", line: lineNumber });
    }
    if (/^ {0,3}\d+\)\s+/.test(line)) {
      addFeature(features, { code: "unsupported-list", message: "Ordered lists must use a period marker.", line: lineNumber });
    }
    if (/^\s{2,}(?:[-+*]|\d+\.)\s+/.test(line)) {
      addFeature(features, { code: "unsupported-list", message: "Nested list indentation uses source mode.", line: lineNumber });
    }
    if (linkPattern.test(line) && /\]\([^)]*\s+[^)]*\)/.test(line)) {
      addFeature(features, { code: "unsupported-link", message: "Links with titles or spaces in destinations use source mode.", line: lineNumber });
    }
  }

  if (inFence) {
    addFeature(features, { code: "fenced-code", message: "An unterminated fenced code block uses source mode." });
  }

  return { supported: features.length === 0, features };
}
