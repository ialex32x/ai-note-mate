/**
 * Convert a machine-style identifier (e.g. `snake_case`, `kebab-case`) into a
 * human-friendly Title Case label.
 *
 *   "sub_agent_name"   -> "Sub Agent Name"
 *   "web-search-tool"  -> "Web Search Tool"
 *   "MCP_SERVER"       -> "MCP SERVER" → "Mcp Server" (each word's first
 *                        letter uppercased, the rest lowercased)
 *
 * Behavior:
 * - Both `_` and `-` are treated as word separators and replaced with a single
 *   space.
 * - Consecutive separators collapse into one space; leading/trailing spaces
 *   are trimmed.
 * - Each resulting word is lowercased then its first character uppercased,
 *   so already-uppercase or mixed-case inputs are normalized consistently.
 * - Empty input returns an empty string.
 */
export function humanizeIdentifier(s: string): string {
    if (!s) return "";
    return s
        .replace(/[_-]+/g, " ")
        .trim()
        .split(/\s+/)
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(" ");
}
