import {
  researchCitationValidationSchema,
  type ResearchCitationLocation,
  type ResearchCitationUsage,
  type ResearchCitationValidation,
  type ResearchFrozenSourceBinding,
} from "../../../../packages/shared/src/research/contracts.js";

/** A stable citation key derived only from an immutable source/version identity. */
export function citationKeyForBinding(binding: Pick<ResearchFrozenSourceBinding, "sourceId" | "versionId" | "citationKey">): string {
  if (binding.citationKey) return binding.citationKey;
  return `src-${binding.sourceId.replace(/^src_/, "")}-ev-${binding.versionId.replace(/^ev_/, "")}`;
}

function lineColumn(markdown: string, offset: number): { line: number; column: number } {
  const before = markdown.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: offset - lastNewline };
}

function excerptAt(markdown: string, offset: number): string {
  const start = markdown.lastIndexOf("\n", offset) + 1;
  const end = markdown.indexOf("\n", offset);
  return markdown.slice(start, end === -1 ? markdown.length : end).trim().slice(0, 4_000);
}

function citationLocation(reportPath: string, markdown: string, offset: number): ResearchCitationLocation {
  const position = lineColumn(markdown, offset);
  return { relativePath: reportPath, line: position.line, column: position.column, endLine: position.line, endColumn: position.column };
}

/**
 * Validates Pandoc-style citations against the exact frozen source/version set.
 * The parser intentionally does not infer or repair keys: an unknown or
 * ambiguous key remains visible to review and disables acceptance upstream.
 */
export function validateReportCitations(
  markdown: string,
  reportPath: string,
  bindings: ResearchFrozenSourceBinding[],
): ResearchCitationValidation {
  const byKey = new Map<string, ResearchFrozenSourceBinding[]>();
  for (const binding of bindings) {
    const key = citationKeyForBinding(binding);
    const entries = byKey.get(key) ?? [];
    entries.push(binding);
    byKey.set(key, entries);
  }

  const usages: ResearchCitationUsage[] = [];
  const unresolvedKeys = new Set<string>();
  const ambiguousKeys = new Set<string>();
  let usageIndex = 0;
  const citationGroup = /\[([^\]]*@[A-Za-z0-9][A-Za-z0-9._:-]*(?:[^\]]*)?)\]/g;
  let group: RegExpExecArray | null;
  while ((group = citationGroup.exec(markdown)) !== null) {
    const body = group[1];
    const keyPattern = /@([A-Za-z0-9][A-Za-z0-9._:-]*)/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyPattern.exec(body)) !== null) {
      const key = keyMatch[1];
      const absoluteOffset = group.index + 1 + keyMatch.index;
      const candidates = byKey.get(key) ?? [];
      if (candidates.length === 0) {
        unresolvedKeys.add(key);
        continue;
      }
      if (candidates.length !== 1) {
        ambiguousKeys.add(key);
        continue;
      }
      const binding = candidates[0];
      const position = lineColumn(markdown, absoluteOffset);
      usages.push({
        usageId: `usage-${usageIndex++}`,
        citationKey: key,
        sourceId: binding.sourceId,
        versionId: binding.versionId,
        location: citationLocation(reportPath, markdown, absoluteOffset),
        excerpt: excerptAt(markdown, absoluteOffset),
      });
      // Keep the position calculation above explicit: it makes malformed
      // multi-citation groups deterministic without exposing report content.
      void position;
    }
  }

  const unresolved = [...unresolvedKeys].sort();
  const ambiguous = [...ambiguousKeys].sort();
  const status = unresolved.length === 0 && ambiguous.length === 0
    ? "valid"
    : usages.length > 0 ? "partial" : "failed";
  const diagnostics = status === "valid"
    ? usages.length === 0 ? "No Pandoc citations were found in the report" : `${usages.length} citation usage(s) validated against frozen source versions`
    : [
      unresolved.length ? `Unresolved citation keys: ${unresolved.join(", ")}` : "",
      ambiguous.length ? `Ambiguous citation keys: ${ambiguous.join(", ")}` : "",
      `${usages.length} citation usage(s) validated before failure`,
    ].filter(Boolean).join("; ");

  return researchCitationValidationSchema.parse({
    status,
    unresolvedKeys: unresolved,
    ambiguousKeys: ambiguous,
    usages,
    diagnostics,
  });
}

export const validateCitations = validateReportCitations;
