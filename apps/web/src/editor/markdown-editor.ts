import { EditorState } from "@tiptap/pm/state";
import { Schema, type Node as ProseMirrorNode, type NodeSpec, type MarkSpec } from "@tiptap/pm/model";
import {
  parseMarkdown,
  serializeMarkdown,
  type MarkdownDocument,
  type MarkdownParseResult,
  type SourceFallbackMarkdown,
  type SupportedMarkdown,
} from "@margin/shared/markdown";

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: { group: "block", content: "inline*" },
  text: { group: "inline" },
  heading: { group: "block", content: "inline*", defining: true, attrs: { level: { default: 1 } } },
  blockquote: { group: "block", content: "block+" },
  bulletList: { group: "block", content: "listItem+" },
  orderedList: { group: "block", content: "listItem+", attrs: { order: { default: 1 } } },
  listItem: { content: "paragraph block*" },
  table: { group: "block", content: "tableRow+" },
  tableRow: { content: "(tableHeader | tableCell)+" },
  tableHeader: { content: "block+" },
  tableCell: { content: "block+" },
};

const marks: Record<string, MarkSpec> = {
  em: {},
  strong: {},
  link: { inclusive: false, attrs: { href: {}, title: { default: null } } },
  citation: { inclusive: false, attrs: { key: {} } },
};

/** The deliberately small schema shared by the visual Markdown editor. */
export const markdownSchema = new Schema({ nodes, marks });

export interface MarkdownEditorBase {
  readonly mode: "visual" | "source";
  readonly dialect: "supported" | "unsupported";
  serialize(): string;
  getSource(): string;
}

export interface SourceMarkdownEditor extends MarkdownEditorBase {
  readonly mode: "source";
  readonly dialect: "unsupported";
  readonly detection: SourceFallbackMarkdown["detection"];
  replaceSource(source: string): void;
}

export interface VisualMarkdownEditor extends MarkdownEditorBase {
  readonly mode: "visual";
  readonly dialect: "supported";
  readonly detection: SupportedMarkdown["detection"];
  getDocument(): MarkdownDocument;
  replaceText(search: string, replacement: string): void;
}

export type MarkdownEditor = SourceMarkdownEditor | VisualMarkdownEditor;

class SourceEditor implements SourceMarkdownEditor {
  readonly mode = "source" as const;
  readonly dialect = "unsupported" as const;
  private currentSource: string;

  constructor(private readonly result: SourceFallbackMarkdown) {
    this.currentSource = result.source;
  }

  get detection(): SourceFallbackMarkdown["detection"] {
    return this.result.detection;
  }

  serialize(): string {
    return this.currentSource;
  }

  getSource(): string {
    return this.currentSource;
  }

  replaceSource(source: string): void {
    this.currentSource = source;
  }
}

class VisualEditor implements VisualMarkdownEditor {
  readonly mode = "visual" as const;
  readonly dialect = "supported" as const;
  private state: EditorState;

  constructor(private readonly result: SupportedMarkdown) {
    const doc = markdownSchema.nodeFromJSON(result.document);
    this.state = EditorState.create({ schema: markdownSchema, doc });
  }

  get detection(): SupportedMarkdown["detection"] {
    return this.result.detection;
  }

  getDocument(): MarkdownDocument {
    return this.state.doc.toJSON() as MarkdownDocument;
  }

  serialize(): string {
    return serializeMarkdown(this.getDocument());
  }

  getSource(): string {
    return this.serialize();
  }

  /** Apply a real ProseMirror transaction to the first matching text node. */
  replaceText(search: string, replacement: string): void {
    if (search.length === 0) throw new Error("Text replacement search cannot be empty");
    let range: { from: number; to: number } | undefined;
    this.state.doc.descendants((node, position) => {
      if (!range && node.isText && node.text?.includes(search)) {
        const start = node.text.indexOf(search);
        range = { from: position + start, to: position + start + search.length };
      }
      return !range;
    });
    if (!range) throw new Error(`Text not found: ${search}`);
    this.state = this.state.apply(this.state.tr.insertText(replacement, range.from, range.to));
  }

  getProseMirrorState(): EditorState {
    return this.state;
  }
}

/**
 * Open Markdown through the visual editor when the dialect is supported.
 * Unsupported syntax remains byte-for-byte source text instead of being
 * silently normalized into a lossy visual document.
 */
export function openMarkdown(source: string): MarkdownEditor {
  const result: MarkdownParseResult = parseMarkdown(source);
  return result.mode === "visual" ? new VisualEditor(result) : new SourceEditor(result);
}

export function isVisualMarkdownEditor(editor: MarkdownEditor): editor is VisualMarkdownEditor {
  return editor.mode === "visual";
}

export function isSourceMarkdownEditor(editor: MarkdownEditor): editor is SourceMarkdownEditor {
  return editor.mode === "source";
}

export function toProseMirrorDocument(document: MarkdownDocument): ProseMirrorNode {
  return markdownSchema.nodeFromJSON(document);
}
