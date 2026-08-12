import { detectMarkdownDialect } from "./dialect.js";
import { serializeMarkdown } from "./serializer.js";
class MarkdownParseError extends Error {
    line;
    constructor(message, line) {
        super(message);
        this.line = line;
        this.name = "MarkdownParseError";
    }
}
const headingPattern = /^ {0,3}(#{1,6})(?:\s+)(.*)$/;
const bulletPattern = /^ {0,3}([-+*])\s+(.+)$/;
const orderedPattern = /^ {0,3}(\d+)\.\s+(.+)$/;
const quotePattern = /^ {0,3}> ?(.*)$/;
const allowedEscapes = new Set(["\\", "*", "_", "[", "]", "(", ")", "#", ">", "|", "-", "+", "."]);
function textNode(text, marks = []) {
    return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}
function sameMarks(left, right) {
    return JSON.stringify(left ?? []) === JSON.stringify(right);
}
function pushText(nodes, text, marks) {
    if (text.length === 0)
        return;
    const previous = nodes.at(-1);
    if (previous?.type === "text" && sameMarks(previous.marks, marks)) {
        previous.text = `${previous.text ?? ""}${text}`;
        return;
    }
    nodes.push(textNode(text, marks));
}
function findClosing(text, marker, from) {
    for (let index = from; index <= text.length - marker.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }
        if (text.startsWith(marker, index))
            return index;
    }
    return -1;
}
function parseInline(text, activeMarks = []) {
    const nodes = [];
    let plain = "";
    const flush = () => {
        pushText(nodes, plain, activeMarks);
        plain = "";
    };
    for (let index = 0; index < text.length;) {
        const remainder = text.slice(index);
        if (text[index] === "\\") {
            const escaped = text[index + 1];
            if (!escaped || !allowedEscapes.has(escaped)) {
                throw new MarkdownParseError("Only Markdown punctuation escapes are supported.");
            }
            plain += escaped;
            index += 2;
            continue;
        }
        const citation = remainder.match(/^\[(?:@[A-Za-z0-9][A-Za-z0-9:_./+-]*(?:,\s*[^\]]+)?(?:;\s*@[A-Za-z0-9][A-Za-z0-9:_./+-]*(?:,\s*[^\]]+)?)*)\]/);
        if (citation) {
            flush();
            const raw = citation[0];
            pushText(nodes, raw, [...activeMarks, { type: "citation", attrs: { key: raw.slice(1, -1) } }]);
            index += raw.length;
            continue;
        }
        const link = remainder.match(/^\[([^\]]+)\]\(([^()\s]+)\)/);
        if (link) {
            flush();
            const label = link[1] ?? "";
            if (/[\\*_`\[\]]/.test(label)) {
                throw new MarkdownParseError("Formatted link labels are not in the supported dialect.");
            }
            pushText(nodes, label, [...activeMarks, { type: "link", attrs: { href: link[2] } }]);
            index += link[0].length;
            continue;
        }
        let marker = "";
        if (remainder.startsWith("***"))
            marker = "***";
        else if (remainder.startsWith("**"))
            marker = "**";
        else if (remainder.startsWith("*"))
            marker = "*";
        else if (remainder.startsWith("__"))
            marker = "__";
        else if (remainder.startsWith("_"))
            marker = "_";
        if (marker) {
            const next = text[index + marker.length];
            const isWordUnderscore = marker.startsWith("_") && /\w/.test(text[index - 1] ?? "") && /\w/.test(next ?? "");
            if (isWordUnderscore) {
                plain += marker;
                index += marker.length;
                continue;
            }
            const closing = findClosing(text, marker, index + marker.length);
            if (closing < 0 || closing === index + marker.length) {
                throw new MarkdownParseError(`Unmatched ${marker} emphasis marker.`);
            }
            flush();
            const inner = text.slice(index + marker.length, closing);
            const marks = marker === "***" || marker === "___"
                ? [...activeMarks, { type: "strong" }, { type: "em" }]
                : marker.length === 2
                    ? [...activeMarks, { type: "strong" }]
                    : [...activeMarks, { type: "em" }];
            nodes.push(...parseInline(inner, marks));
            index = closing + marker.length;
            continue;
        }
        if (text[index] === "`" || text[index] === "~") {
            throw new MarkdownParseError("Inline code and strike-through are not in the supported dialect.");
        }
        plain += text[index] ?? "";
        index += 1;
    }
    flush();
    return nodes;
}
function isBlank(line) {
    return line.trim() === "";
}
function isBlockStart(lines, index) {
    const line = lines[index] ?? "";
    return headingPattern.test(line) || bulletPattern.test(line) || orderedPattern.test(line) || quotePattern.test(line) || isTableStart(lines, index);
}
function splitTableRow(line) {
    const trimmed = line.trim();
    if (!trimmed.includes("|"))
        throw new MarkdownParseError("A table row must contain a pipe separator.");
    const cells = [];
    let current = "";
    let escaped = false;
    for (const character of trimmed) {
        if (escaped) {
            current += `\\${character}`;
            escaped = false;
        }
        else if (character === "\\") {
            escaped = true;
        }
        else if (character === "|") {
            cells.push(current.trim());
            current = "";
        }
        else {
            current += character;
        }
    }
    if (escaped)
        current += "\\";
    cells.push(current.trim());
    if (trimmed.startsWith("|"))
        cells.shift();
    if (trimmed.endsWith("|"))
        cells.pop();
    if (cells.length < 2 || cells.some((cell) => cell.length === 0)) {
        throw new MarkdownParseError("Tables require at least two non-empty cells.");
    }
    return cells;
}
function isTableSeparator(line, expectedCells) {
    try {
        const cells = splitTableRow(line);
        return cells.length === expectedCells && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }
    catch {
        return false;
    }
}
function isTableStart(lines, index) {
    const row = lines[index] ?? "";
    if (!row.includes("|") || index + 1 >= lines.length)
        return false;
    try {
        return splitTableRow(row).length >= 2 && isTableSeparator(lines[index + 1] ?? "", splitTableRow(row).length);
    }
    catch {
        return false;
    }
}
function parseTable(lines, start) {
    const header = splitTableRow(lines[start] ?? "");
    if (!isTableSeparator(lines[start + 1] ?? "", header.length)) {
        throw new MarkdownParseError("Malformed table separator.", start + 2);
    }
    const rows = [{ type: "tableRow", content: header.map((cell) => ({ type: "tableHeader", content: [{ type: "paragraph", content: parseInline(cell) }] })) }];
    let index = start + 2;
    while (index < lines.length && !isBlank(lines[index] ?? "") && (lines[index] ?? "").includes("|")) {
        const cells = splitTableRow(lines[index] ?? "");
        if (cells.length !== header.length)
            throw new MarkdownParseError("All table rows must have the same number of cells.", index + 1);
        rows.push({ type: "tableRow", content: cells.map((cell) => ({ type: "tableCell", content: [{ type: "paragraph", content: parseInline(cell) }] })) });
        index += 1;
    }
    return { node: { type: "table", content: rows }, next: index };
}
function parseList(lines, start, ordered) {
    const itemPattern = ordered ? orderedPattern : bulletPattern;
    const first = (lines[start] ?? "").match(itemPattern);
    if (!first)
        throw new MarkdownParseError("Malformed list item.", start + 1);
    const items = [];
    let index = start;
    let expectedOrder = ordered ? Number(first[1] ?? 1) : undefined;
    while (index < lines.length) {
        const match = (lines[index] ?? "").match(itemPattern);
        if (!match)
            break;
        if (ordered && Number(match[1]) !== expectedOrder) {
            throw new MarkdownParseError("Ordered list numbering must be consecutive.", index + 1);
        }
        const value = ordered ? match[2] : match[2];
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(value ?? "") }] });
        if (expectedOrder !== undefined)
            expectedOrder += 1;
        index += 1;
    }
    return {
        node: {
            type: ordered ? "orderedList" : "bulletList",
            ...(ordered ? { attrs: { order: Number(first[1] ?? 1) } } : {}),
            content: items,
        },
        next: index,
    };
}
function parseBlocks(lines) {
    const nodes = [];
    let index = 0;
    while (index < lines.length) {
        if (isBlank(lines[index] ?? "")) {
            index += 1;
            continue;
        }
        const line = lines[index] ?? "";
        const heading = line.match(headingPattern);
        if (heading) {
            let value = (heading[2] ?? "").trim();
            value = value.replace(/\s+#+\s*$/, "").trim();
            if (value.length === 0)
                throw new MarkdownParseError("Headings must contain text.", index + 1);
            nodes.push({ type: "heading", attrs: { level: heading[1]?.length ?? 1 }, content: parseInline(value) });
            index += 1;
            continue;
        }
        if (isTableStart(lines, index)) {
            const table = parseTable(lines, index);
            nodes.push(table.node);
            index = table.next;
            continue;
        }
        if (quotePattern.test(line)) {
            const quoteLines = [];
            while (index < lines.length && quotePattern.test(lines[index] ?? "")) {
                quoteLines.push((lines[index] ?? "").match(quotePattern)?.[1] ?? "");
                index += 1;
            }
            const content = parseBlocks(quoteLines);
            nodes.push({ type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph" }] });
            continue;
        }
        if (bulletPattern.test(line)) {
            const list = parseList(lines, index, false);
            nodes.push(list.node);
            index = list.next;
            continue;
        }
        if (orderedPattern.test(line)) {
            const list = parseList(lines, index, true);
            nodes.push(list.node);
            index = list.next;
            continue;
        }
        const paragraphLines = [];
        while (index < lines.length && !isBlank(lines[index] ?? "") && !isBlockStart(lines, index)) {
            paragraphLines.push(lines[index] ?? "");
            index += 1;
        }
        if (paragraphLines.length === 0)
            throw new MarkdownParseError("Could not classify Markdown block.", index + 1);
        nodes.push({ type: "paragraph", content: parseInline(paragraphLines.join(" ")) });
    }
    return nodes.length > 0 ? nodes : [{ type: "paragraph" }];
}
function parseErrorFeature(error) {
    const parseError = error instanceof MarkdownParseError ? error : undefined;
    return {
        code: "parse-error",
        message: parseError?.message ?? "Markdown could not be represented by the visual editor.",
        ...(parseError?.line ? { line: parseError.line } : {}),
    };
}
export function parseMarkdown(source) {
    const detection = detectMarkdownDialect(source);
    if (!detection.supported) {
        return { mode: "source", dialect: "unsupported", source, detection };
    }
    try {
        const lines = source.replace(/\r\n?/g, "\n").split("\n");
        const document = { type: "doc", content: parseBlocks(lines) };
        return { mode: "visual", dialect: "supported", document, canonicalMarkdown: serializeMarkdown(document), detection };
    }
    catch (error) {
        const fallbackDetection = { supported: false, features: [...detection.features, parseErrorFeature(error)] };
        return { mode: "source", dialect: "unsupported", source, detection: fallbackDetection };
    }
}
export { MarkdownParseError };
