import type { MarkdownParseResult } from "./types.js";
declare class MarkdownParseError extends Error {
    readonly line?: number | undefined;
    constructor(message: string, line?: number | undefined);
}
export declare function parseMarkdown(source: string): MarkdownParseResult;
export { MarkdownParseError };
