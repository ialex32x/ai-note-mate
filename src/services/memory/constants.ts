/**
 * Memory feature constants shared across parser, store, prompt builder,
 * tools, and extractor.
 *
 * The whole Memory feature is anchored on three facts:
 *   1. Storage is a single markdown note in the vault, owned by the user.
 *   2. Each memory entry is a single `##` section under the file's `#`
 *      title heading. There is NO sub-heading hierarchy — `###` and deeper
 *      are treated as part of the entry's body.
 *   3. Criticality is a per-entry property encoded in the heading text
 *      as a trailing ` [!]` marker, so users can re-tier an entry by
 *      typing one bracketed token rather than maintaining a parallel
 *      list elsewhere.
 *
 * Other modules import these constants instead of duplicating the suffix
 * string / heading level so a future format tweak is a single-file change.
 */

/**
 * Trailing marker appended to a `##` heading line to mark the section as
 * a critical memory (injected on every turn). Includes the leading space
 * so `Title [!]` and `Title [!]` (extra spaces) parse the same after a
 * trailing `trimEnd()`.
 *
 * Chosen over a single trailing `!` to minimise collisions with legitimate
 * heading punctuation (English questions, emphatic statements, etc.).
 */
export const CRITICAL_HEADING_SUFFIX = ' [!]';

/** Heading level used by memory entries. Anything else is body text. */
export const MEMORY_ENTRY_LEVEL = 2;
