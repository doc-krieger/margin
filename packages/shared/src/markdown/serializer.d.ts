import type { MarkdownDocument } from "./types.js";
/** Serialize the visual editor's JSON to a stable canonical Markdown dialect. */
export declare function serializeMarkdown(document: MarkdownDocument): string;
