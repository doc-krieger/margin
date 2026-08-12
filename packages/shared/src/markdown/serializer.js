function escapeText(value, insideTable = false) {
    let escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/([*_`[\]\\])/g, "\\$1")
        .replace(/#/g, "\\#")
        .replace(/>/g, "\\>");
    if (insideTable)
        escaped = escaped.replace(/\|/g, "\\|");
    return escaped;
}
function markOrder(mark) {
    switch (mark.type) {
        case "strong": return 1;
        case "em": return 2;
        case "link": return 3;
        case "citation": return 4;
    }
}
function serializeInline(nodes, insideTable = false) {
    return (nodes ?? []).map((node) => {
        if (node.type !== "text")
            return "";
        const marks = [...(node.marks ?? [])].sort((left, right) => markOrder(left) - markOrder(right));
        if (marks.some((mark) => mark.type === "citation"))
            return node.text ?? "";
        let value = escapeText(node.text ?? "", insideTable);
        for (const mark of marks) {
            if (mark.type === "strong")
                value = `**${value}**`;
            else if (mark.type === "em")
                value = `*${value}*`;
            else if (mark.type === "link")
                value = `[${value}](${mark.attrs?.href ?? ""})`;
        }
        return value;
    }).join("");
}
function serializeTableCell(node) {
    const paragraph = node.content?.find((child) => child.type === "paragraph");
    return serializeInline(paragraph?.content, true);
}
function serializeTable(node) {
    const rows = node.content ?? [];
    if (rows.length === 0)
        return [];
    const header = rows[0]?.content ?? [];
    const headerLine = `| ${header.map(serializeTableCell).join(" | ")} |`;
    const separator = `| ${header.map(() => "---").join(" | ")} |`;
    const body = rows.slice(1).map((row) => `| ${(row.content ?? []).map(serializeTableCell).join(" | ")} |`);
    return [headerLine, separator, ...body];
}
function serializeBlocks(nodes, listIndent = "") {
    const lines = [];
    for (const node of nodes ?? []) {
        switch (node.type) {
            case "paragraph":
                lines.push(`${listIndent}${serializeInline(node.content)}`);
                break;
            case "heading":
                lines.push(`${listIndent}${"#".repeat(node.attrs?.level ?? 1)} ${serializeInline(node.content)}`);
                break;
            case "blockquote":
                for (const line of serializeBlocks(node.content))
                    lines.push(`${listIndent}> ${line}`.trimEnd());
                break;
            case "bulletList":
            case "orderedList": {
                const ordered = node.type === "orderedList";
                const start = node.attrs?.order ?? 1;
                (node.content ?? []).forEach((item, itemIndex) => {
                    const prefix = ordered ? `${start + itemIndex}. ` : "- ";
                    const itemContent = item.content ?? [];
                    const first = itemContent[0];
                    if (first?.type === "paragraph") {
                        lines.push(`${listIndent}${prefix}${serializeInline(first.content)}`);
                        for (const nested of itemContent.slice(1)) {
                            lines.push(...serializeBlocks([nested], `${listIndent}  `));
                        }
                    }
                    else {
                        lines.push(`${listIndent}${prefix}`.trimEnd());
                        lines.push(...serializeBlocks(itemContent, `${listIndent}  `));
                    }
                });
                break;
            }
            case "table":
                lines.push(...serializeTable(node).map((line) => `${listIndent}${line}`));
                break;
            case "listItem":
            case "tableRow":
            case "tableCell":
            case "tableHeader":
            case "doc":
            case "text":
                lines.push(...serializeBlocks(node.content, listIndent));
                break;
        }
    }
    return lines;
}
/** Serialize the visual editor's JSON to a stable canonical Markdown dialect. */
export function serializeMarkdown(document) {
    return serializeBlocks(document.content).join("\n");
}
