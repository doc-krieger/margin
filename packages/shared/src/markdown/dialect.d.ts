import type { MarkdownDialectDetection } from "./types.js";
/**
 * Detect the intentionally small Markdown dialect accepted by the visual editor.
 * Detection runs before parsing so unsupported syntax cannot be normalized by
 * accident. The original source is retained by the source-mode fallback.
 */
export declare function detectMarkdownDialect(source: string): MarkdownDialectDetection;
