// ─────────────────────────────────────────────
// MCP slug generation
// ─────────────────────────────────────────────
//
// A "slug" is the stable identifier used to build the tool name exposed to
// the LLM (e.g. `mcp_${slug}_${toolName}`). Once assigned to a server it is
// never auto-mutated; only an explicit user action (re-generate) may change
// it. This stability is what allows Skill files to reference tool names by
// string and keep working across plugin restarts, server reconnects, and
// renames of the (unrelated) display name.
//
// Constraints (all enforced here):
// - Charset: [a-z0-9] only. Underscores and hyphens are intentionally
//   excluded: the wrapping pattern `mcp_${slug}_${toolName}` already uses
//   `_` as the structural separator; allowing `_` in slug too would make
//   the resulting tool name ambiguous to read.
// - Max length: 12 characters. Keeps the final tool name well below the
//   64-char limit used by most providers, even after appending a long
//   `toolName`.
// - Empty fallback: when the user's display name strips down to nothing
//   after sanitization (e.g. CJK-only or emoji-only names), the literal
//   string `mcp` is used as the base. The collision handler below will
//   then yield `mcp`, `mcp2`, `mcp3`, …
// - Collisions: when the requested slug is already taken by another
//   server, a numeric suffix is appended. If appending the suffix would
//   exceed MAX_LEN, the base part is trimmed first to make room. The
//   numeric suffix is chosen as the smallest integer ≥ 2 that yields a
//   free slug.

export const MCP_SLUG_MAX_LEN = 12;

const FALLBACK_BASE = 'mcp';

/**
 * Derive a slug base from an arbitrary display name.
 *
 * Steps:
 * 1. Lowercase + NFKD-normalise (so `Café` → `cafe` instead of `caf`).
 * 2. Strip everything outside `[a-z0-9]`.
 * 3. Truncate to {@link MCP_SLUG_MAX_LEN}.
 * 4. If empty, fall back to `mcp`.
 *
 * The returned base is **not** guaranteed to be unique — pair with
 * {@link disambiguateSlug} when uniqueness matters.
 */
export function deriveSlugBase(name: string): string {
	const sanitized = (name ?? '')
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, MCP_SLUG_MAX_LEN);
	return sanitized || FALLBACK_BASE;
}

/**
 * Ensure `candidate` does not collide with any string in `taken`.
 *
 * If `candidate` is free, it is returned as-is. Otherwise the smallest
 * integer suffix ≥ 2 that yields a free slug is appended. When the
 * suffixed slug would exceed {@link MCP_SLUG_MAX_LEN}, the base portion
 * is trimmed before appending so the final result still fits.
 *
 * Examples (with default max length 12):
 *   ("notion", {})                              → "notion"
 *   ("notion", {"notion"})                      → "notion2"
 *   ("notion", {"notion", "notion2"})           → "notion3"
 *   ("postgresdata", {"postgresdata"})          → "postgresdat2"
 *   ("postgresdata", {"postgresdata", "postgresdat2"}) → "postgresdat3"
 *
 * Always terminates: at most `taken.size + 1` integers are tried.
 */
export function disambiguateSlug(candidate: string, taken: ReadonlySet<string>): string {
	if (!taken.has(candidate)) return candidate;

	// Cap the number of attempts at taken.size + 2 — we only need one more
	// free integer than the set's size in the worst case, plus a tiny
	// safety margin against off-by-one bugs.
	const maxAttempts = taken.size + 2;
	for (let n = 2; n <= maxAttempts + 1; n++) {
		const suffix = String(n);
		const room = MCP_SLUG_MAX_LEN - suffix.length;
		// Trim base if the suffix would otherwise push us past MAX_LEN.
		const base = candidate.length > room ? candidate.slice(0, room) : candidate;
		const next = base + suffix;
		if (!taken.has(next)) return next;
	}
	// Defensive fallback: should be unreachable given the loop bound. If
	// we somehow get here, return the candidate unchanged so the caller
	// (which logs collisions) can surface the problem instead of hanging.
	return candidate;
}

/**
 * Generate a fresh, unique slug for a server given its display `name` and
 * the set of slugs already in use by other servers.
 *
 * Equivalent to `disambiguateSlug(deriveSlugBase(name), taken)`.
 */
export function generateSlug(name: string, taken: ReadonlySet<string>): string {
	return disambiguateSlug(deriveSlugBase(name), taken);
}

/** Whether `slug` is a syntactically valid slug (charset + length). */
export function isValidSlug(slug: string): boolean {
	if (!slug) return false;
	if (slug.length > MCP_SLUG_MAX_LEN) return false;
	return /^[a-z0-9]+$/.test(slug);
}
