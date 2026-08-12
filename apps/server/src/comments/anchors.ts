import { createHash } from "node:crypto";
import type { AnchorResult, OrphanReason, TextAnchor } from "../../../../packages/shared/src/comments/contracts.js";

const DEFAULT_CONTEXT_LENGTH = 96;
const COMPARISON_CONTEXT_LENGTH = 32;

export interface CreateTextAnchorOptions {
  contextLength?: number;
  sectionPath?: string[];
}

export interface ReanchoredTextAnchor extends AnchorResult {
  matchedText?: string;
}

export function hashDocument(documentText: string): string {
  return createHash("sha256").update(documentText, "utf8").digest("hex");
}

function hashFingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

/** Return the Markdown heading path that contains an offset. */
export function sectionPathAt(documentText: string, offset: number): string[] {
  const headings: Array<{ level: number; title: string }> = [];
  let cursor = 0;
  for (const line of documentText.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match && cursor <= offset) {
      const level = match[1].length;
      headings.splice(level - 1);
      headings[level - 1] = { level, title: match[2].trim() };
      headings.length = level;
    }
    cursor += line.length + 1;
  }
  return headings.filter((heading): heading is { level: number; title: string } => Boolean(heading)).map((heading) => heading.title);
}

function validateRange(documentText: string, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > documentText.length) {
    throw new RangeError("anchor range must be a non-empty range within the document");
  }
}

export function createTextAnchor(
  documentText: string,
  start: number,
  end: number,
  options: CreateTextAnchorOptions = {},
): TextAnchor {
  validateRange(documentText, start, end);
  const quote = documentText.slice(start, end);
  if (!quote.trim()) throw new RangeError("anchor quote must contain non-whitespace text");
  const contextLength = Math.max(0, Math.floor(options.contextLength ?? DEFAULT_CONTEXT_LENGTH));
  const prefix = documentText.slice(Math.max(0, start - contextLength), start);
  const suffix = documentText.slice(end, Math.min(documentText.length, end + contextLength));
  const sectionPath = options.sectionPath ? [...options.sectionPath] : sectionPathAt(documentText, start);
  const fingerprint = hashFingerprint([quote, prefix, suffix, sectionPath.join("/")]);

  return { quote, prefix, suffix, start, end, sectionPath, fingerprint, documentHash: hashDocument(documentText) };
}

function commonSuffixLength(left: string, right: string): number {
  const length = Math.min(COMPARISON_CONTEXT_LENGTH, left.length, right.length);
  let matched = 0;
  while (matched < length && left[left.length - matched - 1] === right[right.length - matched - 1]) matched += 1;
  return matched;
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(COMPARISON_CONTEXT_LENGTH, left.length, right.length);
  let matched = 0;
  while (matched < length && left[matched] === right[matched]) matched += 1;
  return matched;
}

function contextMatches(anchorContext: string, candidateContext: string, suffix: boolean): boolean {
  if (!anchorContext) return false;
  const matched = suffix ? commonSuffixLength(anchorContext, candidateContext) : commonPrefixLength(anchorContext, candidateContext);
  const compared = Math.min(COMPARISON_CONTEXT_LENGTH, anchorContext.length, candidateContext.length);
  return compared > 0 && matched >= Math.max(8, Math.ceil(compared * 0.75));
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

interface Candidate {
  start: number;
  end: number;
  sectionPath: string[];
  prefixMatch: boolean;
  suffixMatch: boolean;
  sectionMatch: boolean;
}

function findCandidates(anchor: TextAnchor, documentText: string): Candidate[] {
  const candidates: Candidate[] = [];
  let from = 0;
  while (from <= documentText.length - anchor.quote.length) {
    const start = documentText.indexOf(anchor.quote, from);
    if (start < 0) break;
    const end = start + anchor.quote.length;
    const prefix = documentText.slice(Math.max(0, start - anchor.prefix.length), start);
    const suffix = documentText.slice(end, Math.min(documentText.length, end + anchor.suffix.length));
    const candidateSectionPath = sectionPathAt(documentText, start);
    candidates.push({
      start,
      end,
      sectionPath: candidateSectionPath,
      prefixMatch: contextMatches(anchor.prefix, prefix, true),
      suffixMatch: contextMatches(anchor.suffix, suffix, false),
      sectionMatch: samePath(anchor.sectionPath, candidateSectionPath),
    });
    from = start + 1;
  }
  return candidates;
}

function orphan(reason: OrphanReason, confidence = 0): ReanchoredTextAnchor {
  return { status: "orphaned", confidence, orphanReason: reason };
}

/**
 * Re-anchors only when the quote is unique or its stored context selects one
 * candidate clearly. A position alone never breaks a tie: positions are only
 * hints because ordinary edits move them.
 */
export function reanchorTextAnchor(anchor: TextAnchor, documentText: string): ReanchoredTextAnchor {
  if (!anchor.quote || anchor.start < 0 || anchor.end <= anchor.start) return orphan("invalid-anchor");
  const candidates = findCandidates(anchor, documentText);
  if (candidates.length === 0) return orphan("removed-text");

  if (candidates.length === 1) {
    const candidate = candidates[0];
    const contextCount = Number(candidate.prefixMatch) + Number(candidate.suffixMatch);
    const confidence = contextCount === 2 ? 0.99 : candidate.sectionMatch ? 0.92 : 0.86;
    return {
      status: "anchored",
      confidence,
      start: candidate.start,
      end: candidate.end,
      sectionPath: candidate.sectionPath,
      matchedText: anchor.quote,
    };
  }

  const scored = candidates.map((candidate) => ({ candidate, score: Number(candidate.prefixMatch) + Number(candidate.suffixMatch) + Number(candidate.sectionMatch) }));
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  const second = scored[1];
  if (best.score === second.score) {
    return orphan("ambiguous-match", best.score / 3);
  }
  if (best.score < 2) {
    return orphan("context-mismatch", best.score / 3);
  }

  return {
    status: "anchored",
    confidence: best.score === 3 ? 0.99 : 0.91,
    start: best.candidate.start,
    end: best.candidate.end,
    sectionPath: best.candidate.sectionPath,
    matchedText: anchor.quote,
  };
}

export function updateTextAnchor(anchor: TextAnchor, documentText: string, result: ReanchoredTextAnchor): TextAnchor | null {
  if (result.status !== "anchored" || result.start === undefined || result.end === undefined || !result.sectionPath) return null;
  const next = { ...anchor, start: result.start, end: result.end, sectionPath: result.sectionPath, documentHash: hashDocument(documentText) };
  return { ...next, fingerprint: hashFingerprint([next.quote, next.prefix, next.suffix, next.sectionPath.join("/")]) };
}

// Descriptive aliases keep the anchor contract easy to discover at call sites.
export const buildTextAnchor = createTextAnchor;
export const reanchorAnchor = reanchorTextAnchor;
export const resolveTextAnchor = reanchorTextAnchor;
