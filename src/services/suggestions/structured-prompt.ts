/**
 * System prompt snippet appended to the builtin system prompt when the
 * user enables structured follow-up suggestions. Asks the model to
 * append a machine-readable block at the tail of its reply that we
 * can parse into quick-pick buttons.
 */
export const STRUCTURED_SUGGESTIONS_PROMPT = `\

## FOLLOW-UP SUGGESTIONS (optional)
At the END of your reply, if there are natural next actions the user might want, append a hidden HTML comment block in EXACTLY this format (never wrap it in code fences, never mention it in your visible text):

<!--suggestions
- label: short button text (<= 40 characters)
  prompt: the full prompt to resend as the user
- label: ...
  prompt: ...
-->

Rules:
- Include between 1 and 4 entries; OMIT the block entirely when there is no meaningful follow-up.
- Use the same language as the user's latest message for both \`label\` and \`prompt\`.
- \`label\` must be a concise ACTION phrase (imperative or noun phrase). Do NOT phrase it as a question, and do NOT end it with "?" / "？".
- \`prompt\` must be a complete, standalone instruction the user could reasonably send as-is (first-person request is fine).
- Each entry represents ONE option only. Never bundle multiple options into a single entry using "or" / "或者" / "または" / "아니면" / etc. — split them into separate entries instead.
- Do NOT also ask a closing meta-question in the visible reply (e.g. "Would you like me to ... or ...?", "需要我帮你...吗？"). The suggestions block replaces such questions; let the buttons speak for themselves.
- The comment block MUST be the very last thing in your reply.

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
