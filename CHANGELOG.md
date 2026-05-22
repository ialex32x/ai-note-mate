# Changelog

## 1.2.8

### What's new

- **Quick jump to settings** — The session profile dropdown adds gear buttons beside **Profiles** and **Image generation** that open **Settings → Note Mate** scrolled to the matching section.

### Refinements

- **Better tool matching in your language** — The on-demand tool retriever now includes trigger keywords in English plus your UI language (Chinese, Japanese, Korean), so everyday phrasing is more likely to surface the right vault tools.
- **Locale follows Obsidian** — When language is set to Auto, the plugin prefers your **Settings → General → Language** choice instead of guessing from the browser.
- **Selectable insight text** — Insight card titles and summaries can be highlighted and copied like normal text.

### Fixes

- **Stop during web fetch** — Pressing **Stop** while the assistant is fetching a URL cancels cleanly instead of letting the fetch finish quietly in the background.
- **Stop cancels more background work** — Auto title generation, insight extraction, and memory extraction respect cancellation when you stop a turn or close a session.
- **Image gen respects Stop** — Long image-generation API calls now honour cancellation.
- **API key resolution** — Keys stored via Obsidian's secure storage are resolved consistently across image generation, web search, and other network features, with a clear "not configured" message when missing.

---

## 1.2.7

### What's new

- **Refine prompt** — A new **Refine prompt** button (sparkle wand) sits beside **Send** in the input toolbar. Tap it to have your summarizer model rewrite the current draft into a clearer, more precise version of the same request, using the previous turn for context when helpful. Requires a summarizer profile under **Settings → Note Mate → Summarizer**.
- **Issue tracer** — When the plugin hits a known-problem code path, it now records an in-memory diagnostic clue instead of leaving you with only a silent failure. A toolbar button appears when clues are present; open it to review details, copy a snapshot for a bug report, or clear the list. Especially useful on mobile where DevTools is not available.

### Refinements

- **Smarter tool & skill selection** — On-demand tools and per-turn skills are now ranked by a unified retriever that combines keyword matching with embedding similarity when configured. Separate similarity-threshold knobs for tools are gone; tune **Tool retriever: top-K** and **Skill retriever: top-K** instead. The skill trigger tester reflects the new ranking.
- **Sharper "Next steps" chips** — Follow-up suggestion buttons are extracted more reliably from closing questions, including header-less colon lists, and code blocks in the reply no longer produce spurious chips.
- **Stop cancels more work** — Pressing **Stop** while a reply is streaming now propagates cancellation through sub-agents, embeddings, and other long-running steps, so the session settles faster instead of finishing hidden work in the background.
- **Insights extractor badge** — The session profile dropdown marks which profile is currently used as the insights extractor, making it easier to see what will run when you tap **Extract insights**.
- **Input toolbar layout** — **Refine prompt** and **Send** are grouped on the right edge of the toolbar; secondary actions sit to the left of the primary send button for a clearer tweak-then-send flow.
- **Tips popover polish** — Navigation controls inside the tips panel use dedicated icons and tighter mobile sizing for easier browsing on small screens.

---

## 1.2.6

### What's new

- **Memory, rebuilt around a vault note** — Long-term memory is now backed by a markdown note in your vault that you can read, edit, and search like any other note. Each `##` heading is one entry; add a trailing ` [!]` to mark an entry as **critical** (injected on every turn). Plain headings are kept in a *relevant* pool and recalled by embedding similarity to your current question. Obsidian callouts (`> [!info]`, `> [!note]`, …) inside an entry body stay **private**—they are visible to you but stripped before the assistant ever sees them, so you can leave yourself reminders about why an entry exists.
- **Auto-extract memories (opt-in)** — Turn on **Settings → Note Mate → Memory → Auto-extract memories from replies** to let a cheap follow-up LLM call distill durable facts from each reply into memory upserts/deletes. Per-turn caps for upserts, deletes, and minimum reply length keep a noisy reply from overrunning your note.
- **Memory settings panel** — Master toggle, note-path field with **Open** / **Create from template** buttons, a live entry-count status row, and advanced knobs for auto-extract caps and recall tuning (critical budget, relevant top-K, similarity threshold). Per-entry editing happens in the note itself—nothing else to learn.
- **New onboarding tips**
  - **Set up your AI profile** — surfaces when Base URL / model / API key are still empty; opens straight to the Profile section.
  - **Connect MCP servers** — surfaces when no MCP server is configured.
  - **Add an illustration to your note** — when an image-generation profile is set up and the active note has no images, parks a starter prompt for a 512×512 cover illustration.
  - **Reference notes with `[[`** — drops a starter prompt ending in `[[` and opens the file picker so you can pick a note and send.
  - **Try the memory feature** — creates your memory note from the default template with an example critical entry that demonstrates both the `[!]` marker and the callout-as-private-annotation pattern.
- **Friendlier tool error hints** — When the assistant calls `get_metadata` or `write_file` with the wrong argument shape (a bare string, or singular `path` instead of `paths`), the tool now responds with a corrective example instead of a generic failure, so the next attempt is usually right.
- **Clearer inspector tool guidance** — `get_metadata` is now described as the primary inspector for markdown structure and batch inspection; `get_file_state` is reserved for single non-markdown files or simple stat lookups, with an explicit reminder to reuse the `mtime` returned by `read_file` / `read_section` / `get_metadata` instead of calling again.
- **Tip prompts as drafts** — Analyze-vault-structure, Create example base, Create example canvas, and Reference-notes tips now park their starter prompt in the input editor (with the cursor at the end) instead of submitting it, so you can review and tweak before sending. These tips also stay hidden while you're already typing.

### Refinements

- **Checkpoint selector auto-hides** — The toolbar's checkpoint button disappears entirely when there are no pending checkpoints left, and its dropdown closes automatically the moment you accept or discard the last pending entry.
- **Todo panel starts collapsed** — New sessions open with the todo panel folded into a single-line header to keep the input row compact; expand it whenever you want the full list. Your fold preference is preserved across `todo-update` re-renders as before.
- **Todo panel polish** — Tighter spacing and improved contrast for better readability.

### Heads-up

- **Legacy memory data is dropped.** The old `memories` array stored in `data.json` is no longer used and is removed on first load of this version. If you had memories saved under the previous format and want to keep them, **export them before upgrading**. After the upgrade, seed your new memory note via **Tips → Try the memory feature** or write entries directly in the note.
- **`memory_recall` tool removed.** Recall now happens automatically via the system-prompt prefix. The model continues to use `memory_store` (with `heading` / `body` / `critical`) and `memory_delete` (by `heading`).

---

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
