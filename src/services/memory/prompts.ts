/**
 * Prompts used by the auto-memory extractor.
 *
 * The extractor mirrors {@link ../insights/prompts} in spirit: a single,
 * stateless LLM call that ingests one user→assistant turn and returns a
 * tightly-typed JSON array describing the memory operations to apply.
 *
 * Output schema (one object per array entry):
 *   {
 *     "op": "upsert" | "delete",
 *     "heading": string,           // logical heading (no `[!]` marker)
 *     "critical": boolean,         // only for upserts; ignored for deletes
 *     "body": string               // only for upserts; ≤ 600 chars
 *   }
 *
 * The downstream parser tolerates extra/unknown keys but rejects unknown
 * `op` values so future extensions stay backward-compatible.
 */

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `\
You maintain a long-term memory store for an AI assistant embedded in a personal notes app.

After every user→assistant turn, you decide what (if anything) should be ADDED or REMOVED from memory to make future turns better, given ONLY this single turn as evidence.

Return ONLY a JSON array (optionally wrapped in a \`\`\`json fence). No prose, no explanations, no trailing text.

Each array entry MUST be one of:
- { "op": "upsert", "heading": "<short title, ≤ 60 chars>", "critical": <true|false>, "body": "<≤ 600 chars, same language as user>" }
- { "op": "delete", "heading": "<exact logical heading to remove>" }

Selection rules:
- Memory is precious — be CONSERVATIVE. Empty array \`[]\` is the right answer for almost every casual turn.
- Emit AT MOST {maxUpserts} upserts and AT MOST {maxDeletes} deletes per turn.
- Upsert ONLY information that:
  - is durable (would still apply in a week) — preferences, identities, recurring projects, naming conventions, hard rules the user volunteered;
  - is general enough to help future turns, not a one-off Q&A answer;
  - is NOT already covered by an existing memory entry (use the list provided in the user prompt).
- Critical (\`"critical": true\`) is reserved for entries the assistant MUST recall on every turn (personal identity, fixed reply rules, communication preferences, hard refusals). Use it sparingly; everything else stays relevant (\`false\`).
- Delete an entry ONLY when the user explicitly rescinded, replaced, or corrected it in THIS turn. Do NOT delete based on inference, silence, or apparent contradiction with the assistant.
- \`heading\` is short, sentence-cased, in the user's language, and does NOT contain the \` [!]\` marker. The runtime adds the marker based on \`critical\`.
- \`body\` is one or two sentences (or a short bullet list) capturing the durable fact. Write it as a directive the assistant can read literally — not as a third-person description of the conversation.

What NOT to store:
- The exact wording of the user's question or the assistant's reply.
- Transient task state (file paths being edited right now, search results, tool outputs).
- Greetings, meta-chat, model self-introspection, apologies.
- Anything sensitive the user did not ask to remember (passwords, secrets, real names they did not volunteer).

Language: match the user's message language for \`heading\` and \`body\`.
`;

/** Build the user-role message fed to the extractor. */
export function buildMemoryUserPrompt(input: {
    userMessage: string;
    assistantMessage: string;
    existingEntries: ReadonlyArray<{ heading: string; critical: boolean; body: string }>;
}): string {
    const { userMessage, assistantMessage, existingEntries } = input;
    const existingBlock = existingEntries.length === 0
        ? '(memory is currently empty)'
        : existingEntries
            .map(e => `- ${e.critical ? '[CRITICAL] ' : ''}${e.heading}: ${shorten(e.body, 200)}`)
            .join('\n');

    return [
        'CURRENT MEMORY ENTRIES (do not duplicate; reference these when deciding upsert vs no-op):',
        existingBlock,
        '',
        'USER MESSAGE:',
        '"""',
        userMessage.trim(),
        '"""',
        '',
        'ASSISTANT REPLY:',
        '"""',
        assistantMessage.trim(),
        '"""',
        '',
        'Output the JSON array now.',
    ].join('\n');
}

function shorten(s: string, max: number): string {
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= max) return collapsed;
    return collapsed.slice(0, max - 1) + '…';
}

// ── Consolidation prompt ───────────────────────────────────────────────────

export const MEMORY_CONSOLIDATION_SYSTEM_PROMPT = `\
You maintain a long-term memory store. The non-critical ("relevant") pool has grown too large ({count} entries against a capacity of {threshold}). Your job is to CONSOLIDATE: merge related entries into fewer, denser entries, and delete entries that are clearly obsolete or trivial.

Rules:
- The goal is to reduce the entry COUNT while preserving ALL durable information. Merge, don't drop facts.
- Merge entries that overlap semantically. Examples:
  * "user prefers dark mode" + "uses OLED screen" → "prefers dark mode; uses OLED screens which benefit from true blacks"
  * "working on Project X" + "Project X deadline is Friday" → "working on Project X (deadline Friday)"
- Delete entries that are:
  * Clearly obsolete (stale one-off facts, preferences the user has since contradicted in another entry)
  * Trivial noise (e.g., "user asked about weather once")
  * Redundant after a merge (the merged entry absorbs them)
- Do NOT delete durable preferences, recurring projects, or identity facts unless they are fully absorbed by a merge.
- Critical entries are listed as READ-ONLY reference. Do NOT modify or delete them — only use them to avoid creating duplicate non-critical entries.

Output format: a JSON array of operations (optionally wrapped in \`\`\`json). Each operation is:
- { "op": "upsert", "heading": "<≤60 chars>", "critical": false, "body": "<≤600 chars>" } — add/replace an entry
- { "op": "delete", "heading": "<exact logical heading to remove>" } — delete an entry

Important:
- heading does NOT contain the \` [!]\` marker.
- heading and body should be in the same language as the existing entries.
- Return \`[]\` only if no consolidation is needed (pool is already clean).
- Aim to reduce non-critical entries by at least 30%.`;

/** Build the user message listing all current entries for consolidation. */
export function buildConsolidationUserPrompt(entries: ReadonlyArray<{
    heading: string;
    critical: boolean;
    body: string;
}>): string {
    const nonCritical = entries.filter(e => !e.critical);
    const critical = entries.filter(e => e.critical);

    const nonCriticalBlock = nonCritical.length === 0
        ? '(no non-critical entries — nothing to consolidate)'
        : nonCritical
            .map(e => `- ${e.heading}: ${shorten(e.body, 400)}`)
            .join('\n');

    const criticalBlock = critical.length === 0
        ? '(none)'
        : critical
            .map(e => `- [CRITICAL, READ-ONLY] ${e.heading}: ${shorten(e.body, 200)}`)
            .join('\n');

    return [
        `NON-CRITICAL ENTRIES (these are the target for consolidation — you may merge, replace, or delete them):`,
        nonCriticalBlock,
        '',
        `CRITICAL ENTRIES (READ-ONLY — do NOT touch; listed only so you don't create duplicate non-critical entries):`,
        criticalBlock,
        '',
        'Output the JSON array now. Remember: only upsert/delete NON-CRITICAL entries.',
    ].join('\n');
}
