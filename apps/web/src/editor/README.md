# Markdown editor fidelity contract

The editor uses a deliberately narrow ProseMirror schema distributed by `@tiptap/pm`. The supported visual dialect is:

- ATX headings (`#` through `######`), paragraphs, blockquotes, and flat unordered or ordered lists;
- emphasis, strong emphasis, links with a simple destination, and Pandoc-style citations such as `[@smith2024, p. 12]`;
- pipe tables with a separator row. The first row is treated as the header and table alignment is intentionally canonicalized away.

Fenced or indented code, raw HTML, images, reference definitions, footnotes, task lists, thematic breaks, setext headings, strike-through, inline code, hard breaks, nested lists, and links with titles are outside this first visual dialect.

`openMarkdown` calls `detectMarkdownDialect` before parsing. When a feature is outside the contract, or parsing fails, it returns a source-mode editor whose `serialize()` returns the original source exactly. This is the source-fallback guarantee: unsupported Markdown is never silently normalized. The fixture and repeated round-trip tests in `tests/editor/markdown-editor.test.ts` are the executable evidence for this behavior.
