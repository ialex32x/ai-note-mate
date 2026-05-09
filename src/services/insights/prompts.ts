/**
 * Prompts used by the insight extractor.
 *
 * We ask the (cheap) summarizer model to emit a strict JSON array so
 * parsing stays deterministic. A fenced code block is tolerated but
 * not required.
 */

export const INSIGHT_EXTRACTION_SYSTEM_PROMPT = `\
You extract small, reusable knowledge nuggets ("insights") from a single Q&A turn between a user and an AI assistant inside a personal notes app.

Return ONLY a JSON array (optionally wrapped in a \`\`\`json code fence). No prose, no explanations, no trailing text.

Each array entry MUST be an object with these fields:
- "title":       string — concise concept name, <= 30 chars, no trailing punctuation.
- "summary":     string — 1-2 short sentences capturing the nugget in the SAME language as the user's message.
- "tags":        string[] — 0-5 short lowercase keywords, no "#" prefix, no spaces (use "-" instead).
- "linkedNotes": string[] — 0-5 note titles (bare, no brackets) that the assistant reply explicitly cited via [[wiki-links]] or equivalent. NEVER invent titles.

Selection rules:
- Only extract insights that are self-contained and would still make sense as a standalone note a week later.
- Do NOT extract greetings, meta-commentary, apologies, or clarification questions.
- Do NOT extract items that merely restate the user's question.
- Prefer definitions, design decisions, comparisons, trade-offs, step-by-step procedures, named concepts, or concrete gotchas.
- Return an empty array "[]" when no worthy insight exists. Being silent is better than being noisy.
- Emit AT MOST {limit} entries, ordered by descending usefulness.

Language: match the user's message language for "title" and "summary". Keep "tags" lowercase ASCII/CJK as appropriate.
`;

/** Build the user-role message fed to the extractor. */
export function buildInsightUserPrompt(userMessage: string, assistantMessage: string): string {
    return [
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
        'Extract the insights now. Reply with JSON array only.',
    ].join('\n');
}

/**
 * Compose the user-facing message that is sent on the user's behalf when
 * they click the "Deepen" button on an insight item. The message is sent
 * as a normal user turn (so the model can call tools, stream, etc.) — it
 * therefore needs to read naturally as if the user typed it.
 *
 * Per project decision the prompt is always English regardless of UI
 * locale; the model is told to reply in the same language as the
 * surrounding conversation, which keeps things consistent without
 * having to maintain five translated templates.
 */
export function buildInsightDeepenPrompt(input: {
    title: string;
    summary: string;
    tags: string[];
    linkedNotes: string[];
}): string {
    const lines: string[] = [
        'Please go deeper on the following insight from our conversation and turn it into a more complete, self-contained piece that I could save as a standalone note.',
        '',
        `- Title: ${input.title}`,
        `- Summary: ${input.summary}`,
    ];
    if (input.tags.length > 0) {
        lines.push(`- Tags: ${input.tags.join(', ')}`);
    }
    if (input.linkedNotes.length > 0) {
        lines.push(`- Related notes: ${input.linkedNotes.map((n) => `[[${n}]]`).join(', ')}`);
    }
    lines.push(
        '',
        'When useful, call tools to gather additional context (e.g. search the vault, read related notes, fetch external references). Then synthesize the findings.',
        '',
        'In your final reply, cover:',
        '- Background and why this matters',
        '- Key details, definitions, and any important nuances or trade-offs',
        '- Concrete examples or step-by-step guidance where applicable',
        '- Common pitfalls or caveats to watch out for',
        '- References / sources you consulted (if any)',
        '',
        'Reply in the same language as the rest of this conversation. Aim for a polished, note-ready piece — not a brief follow-up answer.',
    );
    return lines.join('\n');
}
