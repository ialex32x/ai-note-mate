/**
 * System prompt snippet appended to the builtin system prompt when the
 * user enables structured follow-up suggestions. Asks the model to
 * append a machine-readable block at the tail of its reply that we
 * can parse into quick-pick buttons.
 */
export const STRUCTURED_SUGGESTIONS_PROMPT = `\

## FOLLOW-UP SUGGESTIONS
Most substantive replies naturally lead to follow-up actions — the user might want to drill deeper into a sub-topic, verify or test a result, apply the answer to a related file, compare with alternatives, or ask for a worked example. Your job is to surface those next steps.

At the END of your reply, append a hidden HTML comment block in EXACTLY this format (never wrap it in code fences, never mention it in your visible text):

<!--suggestions
- label: short button text (<= 40 characters)
  prompt: the full prompt to resend as the user
- label: ...
  prompt: ...
-->

Rules:
- Include 2–4 entries for substantive replies (information delivery, analysis, task results, explanations, etc.). Think of common follow-up patterns: elaborate, verify, apply, compare, show an example, check edge-cases.
- Omit the block ONLY when the reply is purely conversational (greetings, thanks, simple acknowledgements) and genuinely has zero meaningful extensions. When in doubt, INCLUDE — a slightly speculative suggestion is better than none.
- Use the same language as the user's latest message for both \`label\` and \`prompt\`.
- \`label\` must be a concise ACTION phrase (imperative or noun phrase). Do NOT phrase it as a question, and do NOT end it with "?" / "？".
- \`prompt\` must be a complete, standalone instruction the user could reasonably send as-is (first-person request is fine).
- Each entry represents ONE option only. Never bundle multiple options into a single entry using "or" / "或者" / "または" / "아니면" / etc. — split them into separate entries instead.
- Do NOT also ask a closing meta-question in the visible reply (e.g. "Would you like me to ... or ...?", "需要我帮你...吗？"). The suggestions block replaces such questions; let the buttons speak for themselves.
- The comment block MUST be the very last thing in your reply.

### Optional client-side actions
An entry MAY additionally specify a client-side action that is executed directly inside Obsidian when the button is clicked, instead of sending the prompt back to you. Currently supported:

- \`open-note\` — open an existing note in the vault. Requires a \`path\` field with the note's vault path (with or without the ".md" extension; subfolder paths are fine; do NOT wrap the value in \`[[...]]\`).

Format with an action:

<!--suggestions
- label: Open Project plan
  prompt: Open the note "Project plan".
  action: open-note
  path: Projects/Project plan.md
-->

Rules for actions:
- Use \`open-note\` whenever opening a specific note is a natural next step. You do NOT need to verify that the note exists — if it doesn't, Obsidian will follow its usual wiki-link behaviour (by default it creates a new empty note at that path), which is the user's responsibility to configure.
- The \`prompt\` field is still REQUIRED on every entry (it remains the user-visible intent and is reused if the user later re-runs the suggestion as a plain message).
- Prefer the exact path the user or a recent tool result referred to. When only a basename is available, that is fine — Obsidian will resolve it the same way it resolves \`[[...]]\` links.

Example (good):
<!--suggestions
- label: Delete the orphan attachments
  prompt: Please delete all the orphan attachments listed above in a batch.
- label: Check for indirect references
  prompt: Please further check whether any of these attachments are referenced in non-standard ways.
-->

Example (bad — do NOT do this):
> Visible reply ends with: "Would you like me to delete these orphan attachments in a batch, or first check whether any of them are referenced indirectly?"
> (The closing question is redundant with the suggestions block, and bundling two options into one question is not allowed.)
`;
