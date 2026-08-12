export type MarkdownBlockType =
  | "doc"
  | "paragraph"
  | "heading"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "listItem"
  | "table"
  | "tableRow"
  | "tableCell"
  | "tableHeader";

export type MarkdownInlineType = "text";

export type MarkdownMarkType = "em" | "strong" | "link" | "citation";

export interface MarkdownMark {
  type: MarkdownMarkType;
  attrs?: {
    href?: string;
    title?: string | null;
    key?: string;
  };
}

export interface MarkdownNode {
  type: MarkdownBlockType | MarkdownInlineType;
  attrs?: {
    level?: number;
    order?: number;
    href?: string;
    title?: string | null;
  };
  content?: MarkdownNode[];
  text?: string;
  marks?: MarkdownMark[];
}

export interface MarkdownDocument {
  type: "doc";
  content: MarkdownNode[];
}

export interface UnsupportedFeature {
  code:
    | "fenced-code"
    | "indented-code"
    | "raw-html"
    | "image"
    | "reference-definition"
    | "footnote"
    | "task-list"
    | "thematic-break"
    | "setext-heading"
    | "strike-through"
    | "inline-code"
    | "hard-break"
    | "unsupported-heading"
    | "unsupported-list"
    | "unsupported-link"
    | "malformed-table"
    | "parse-error";
  message: string;
  line?: number;
}

export interface MarkdownDialectDetection {
  supported: boolean;
  features: UnsupportedFeature[];
}

export interface SupportedMarkdown {
  mode: "visual";
  dialect: "supported";
  document: MarkdownDocument;
  canonicalMarkdown: string;
  detection: MarkdownDialectDetection;
}

export interface SourceFallbackMarkdown {
  mode: "source";
  dialect: "unsupported";
  source: string;
  detection: MarkdownDialectDetection;
}

export type MarkdownParseResult = SupportedMarkdown | SourceFallbackMarkdown;
