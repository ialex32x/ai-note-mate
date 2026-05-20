/**
 * Pure helpers translating between a memory entry's user-facing logical
 * heading (e.g. `Reply language`) and its on-disk file heading (e.g.
 * `Reply language [!]` for a critical entry, plain for a relevant one).
 *
 * Kept as pure functions (no Obsidian imports) so they are trivial to
 * unit-test and reusable from both the parser and the writer without a
 * dependency cycle through `memory-store`.
 */

import { CRITICAL_HEADING_SUFFIX } from './constants';

/**
 * Detect whether a raw heading text (no leading `#`s, as Obsidian's
 * `HeadingCache.heading` exposes it) is a critical-memory marker.
 *
 * Tolerant of trailing whitespace — the marker is matched after a
 * `trimEnd()` so `Title [!]   ` and `Title [!]` are equivalent.
 */
export function isCriticalHeading(fileHeading: string): boolean {
    const trimmed = fileHeading.trimEnd();
    return trimmed.endsWith(CRITICAL_HEADING_SUFFIX);
}

/**
 * Strip the critical marker (and any whitespace immediately before it)
 * from a file heading, returning the logical name the user authored.
 *
 * - `"Reply language [!]"` → `"Reply language"`
 * - `"Reply language"`     → `"Reply language"`
 * - `"  Reply [!]  "`       → `"Reply"`
 *
 * Returns the input verbatim (only `.trim()`-ed) when no marker is
 * present, so callers can use this as an idempotent normaliser.
 */
export function stripCriticalSuffix(fileHeading: string): string {
    const trimmedEnd = fileHeading.trimEnd();
    if (!trimmedEnd.endsWith(CRITICAL_HEADING_SUFFIX)) {
        return fileHeading.trim();
    }
    return trimmedEnd.slice(0, trimmedEnd.length - CRITICAL_HEADING_SUFFIX.length).trim();
}

/**
 * Compose the on-disk heading text for a memory entry from its logical
 * name and criticality flag. Used by every writer (manual tool,
 * extractor, settings UI promote/demote) so the rendering rule lives in
 * exactly one place.
 *
 * The logical name is `.trim()`-ed but otherwise preserved verbatim —
 * Obsidian's heading matching is case-sensitive and the user is allowed
 * to author headings in any language / casing.
 */
export function formatFileHeading(logical: string, critical: boolean): string {
    const base = logical.trim();
    if (!base) return '';
    return critical ? `${base}${CRITICAL_HEADING_SUFFIX}` : base;
}

/**
 * True when a string is a non-empty logical heading after trimming and
 * after stripping any caller-provided critical marker. Cheap guard the
 * store / tool / extractor all call before mutating the note so we never
 * persist a `## ` empty heading or a heading that is just ` [!]`.
 */
export function isValidLogicalHeading(logical: string): boolean {
    return stripCriticalSuffix(logical).length > 0;
}
