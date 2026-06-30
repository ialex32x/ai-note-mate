/**
 * System prompt snippet appended to the builtin system prompt when the
 * user enables structured follow-up suggestions. Asks the model to
 * append a machine-readable block at the tail of its reply that we
 * can parse into quick-pick buttons.
 */
export const STRUCTURED_SUGGESTIONS_PROMPT = `\

## FOLLOW-UP SUGGESTIONS
At the END of your reply, append a hidden HTML comment block in EXACTLY this format (never wrap in code fences, never mention in visible text):

<!--suggestions
- label: short button text (<= 40 chars)
  prompt: the full prompt to resend as the user
- label: ...
  prompt: ...
-->

Rules:
- Include 2–4 entries for substantive replies. Omit ONLY for purely conversational replies (greetings, thanks). When in doubt, INCLUDE.
- Use the same language as the user's latest message for both \`label\` and \`prompt\`.
- \`label\`: concise ACTION phrase (imperative or noun phrase). NOT a question, no "?" / "？".
- \`prompt\`: complete standalone instruction the user could send as-is.
- One option per entry — never bundle with "or" / "或者" / "または" / "아니면".
- Do NOT ask a closing meta-question in the visible reply — the suggestions block replaces it.
- The comment block MUST be the very last thing in your reply.

### Client-side actions
An entry MAY specify an action executed in Obsidian instead of sending the prompt:

- \`open-note\` — opens a vault note. Adds \`path\` field (vault path, no \`[[...]]\` wrapping):
<!--suggestions
- label: Open Project plan
  prompt: Open the note "Project plan".
  action: open-note
  path: Projects/Project plan.md
-->

\`prompt\` is still REQUIRED on every entry. Use \`open-note\` when opening a specific note is a natural next step.

Example:
<!--suggestions
- label: Delete the orphan attachments
  prompt: Please delete all the orphan attachments listed above in a batch.
- label: Check for indirect references
  prompt: Please further check whether any of these attachments are referenced in non-standard ways.
-->
`;
