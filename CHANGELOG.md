# Changelog

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
