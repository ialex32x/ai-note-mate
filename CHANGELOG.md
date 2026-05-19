# Changelog

## 1.2.5

### What's new

- **Session task list** — For multi-step work, the assistant can maintain a per-session todo list and keep it in sync as tasks move forward. A **Todo** panel pinned above the input shows progress at a glance; the list is saved with the session and survives reloads.
- **Usage tips** — A **Tips** button on the input toolbar opens contextual guidance (create your first skill, try Obsidian Bases or Canvas, and more). Use **Try it** to run a tip with a preview, or **Got it** to dismiss it. Restore dismissed tips under **Settings → Note Mate → Reset usage tips**.
- **Dedicated insights profile** — Choose a separate provider profile for **Extract insights** when you want stronger structured output than your context summarizer, or keep the default to reuse the summarizer.
- **Advanced settings** — Turn on **Show advanced** to reveal parameters that should only be changed when you know their effect; advanced options are labeled in the UI. Context compression threshold is now grouped with other advanced profile settings.
- **Clearer sub-agent bubbles** — Role labels appear only when they add context; delegate handoff bubbles are easier to scan.
- **Copy polish** — Clearer descriptions for built-in tool capabilities and related settings across supported languages.

### Fixes

- **Delegated tasks** — Sub-agent handoff data is shown as a collapsible exchange block (with backward compatibility for older sessions). Invalid exchange payloads surface clearer errors.
- **Long streamed replies** — Markdown rendering during streaming is more efficient on larger assistant messages.

---

## 1.2.4

### What's new

- **Auto-tag** — New **Auto-tag** action in the editor and file menus for Markdown notes. The assistant suggests tags that follow your vault’s conventions; the prompt is parked as a draft in the session input so you can edit it before sending.
- **Continue writing** — AI edit history adds **Continue writing** to pick up from a selection or from where the text ends.
- **Smarter Skills (fewer tokens)** — When an embedding provider is enabled, only skills relevant to the current turn are included in context. Adjust similarity threshold and Top-K under **Settings → Note Mate → Skills**.
- **Skill trigger tester** — Under **Skills**, paste a sample user question to preview which skills match, get a strong hint, or are filtered out—handy for tuning descriptions and triggers without leaving settings.
- **Clearer settings layout** — Skill-filter options now live in the **Skills** section instead of being buried under embeddings.
- **Better “Next step” suggestions** — If the assistant ends with several closing questions, they appear as separate, tappable options instead of one long line.
- **Smoother editor → session handoff** — Actions like **Explain** and **Auto-tag** park the full prompt as a draft in the input box without overwriting text you are already typing.
- **Copy polish** — Buttons, menus, and setting descriptions are more consistent across supported languages.

### Fixes

- **Long conversations** — Emergency context compression no longer drops tool results, so the assistant is less likely to “forget” information it just retrieved from your vault.

---
