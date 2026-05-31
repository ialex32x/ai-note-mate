# Changelog

## 1.4.1

### What's new

- **Jump to previous messages** — Click the new navigation arrow on user message bubbles to jump back to the previous user message, making long conversations easier to scan.
- **Hover timestamps** — Hover over any message's role label to see when it was sent.

### Refinements

- **Follow-up chips auto-send** — Clicking a follow-up suggestion now sends it immediately instead of parking it in the input field.
- **Cleaner sub-agent labels** — Sub-agent names now appear as plain role labels instead of badges, reducing visual clutter.
- **User bubbles get a tint** — Your own messages now have a subtle accent-colour background, making conversation flow easier to follow at a glance.

### Fixes

- **Date formatting** — Session dates in the session switcher now respect your system locale.
- **Copy improvements** — Copying tool-call messages and assistant replies now produces cleaner, more useful text.
- **Scroll stability** — Jumping between messages no longer causes the view to jump or flicker.
- **History prepend** — Loading older messages into a session no longer disrupts the view or loses UI elements.
- **Safe filenames** — The assistant now follows vault naming rules more carefully when creating new notes.

---

## 1.4.0

### What's new

- **Obsidian Bases support** — Create, view, update, and list Obsidian Bases directly from the session. Validation is tightened and singular argument aliases are accepted for smoother calls.
- **Canvas tools** — Update, delete, and auto-layout canvas files with new `canvas_*` tools, plus read and list operations for canvas inspection.
- **Persist interrupted messages** — When you stop a streaming reply, the partial message is now saved to the session instead of being lost.

### Refinements

- **Inclusive `end_line` everywhere** — Both `read_file` and `edit_lines` now use inclusive `end_line` semantics, reverting the half-open ranges introduced in 1.3.4. `insert_lines_before` is merged into `edit_lines` as a unified editing tool.
- **Better vault browsing** — `vaultBrowseFolder` and `vaultReadFile` pagination is clearer and more consistent.
- **Link resolution improvements** — Context menu and wiki-link handling are more robust.
- **Large file threshold raised** — Files under 500 lines no longer trigger sectioned-read hints.
- **Tool description polish** — Delete file/folder and read-file descriptions are clearer about their scope.

### Fixes

- **Datetime locale** — Date formatting now respects the system default locale instead of always using English.
- **Empty heading outlines** — Error messages for notes with no headings are now more helpful.

---

## 1.3.4

### What's new

- **Embedding profile selector in toolbar** — The session toolbar now shows a dropdown to choose which embedding profile to use, matching the text-generation and image-generation selectors.
- **MiniMax model icon** — MiniMax models now have a dedicated icon in the profile selector.
- **`rank_notes_by_embedded_size` tool** — A new tool lets the model rank vault notes by their embedded content size, useful for prioritizing large reference documents.
- **Copy action bar on delegate task bubbles** — Handoff payloads in delegate task bubbles now show a copy button, so you can grab structured data with one click.
- **Edit while streaming** — You can now edit and re-send a message while the assistant is still streaming; the in-progress stream is aborted cleanly and the new prompt takes over.
- **Vault editor sub-agent label and icon** — The built-in vault-editor sub-agent now shows a distinct label and icon in delegation blocks.
- **Large file read hints in metadata** — `get_metadata` now includes clues about large files so the model can decide whether to read a file in sections before attempting a full read.
- **`read_file` end_line exclusive** — The `end_line` parameter in `read_file` is now exclusive (half-open), matching the behaviour of `edit_lines` and other range-based tools.

### Refinements

- **Unified half-open ranges** — `edit_lines` operations now consistently use half-open `[start, end)` semantics, aligning with `read_file` and `read_section`.

### Fixes

- **Status panel render deferred** — The session status dropdown no longer triggers unnecessary renders until it is opened, reducing layout jank.
- **External action bar positioning** — The action bar now moves correctly when a bubble is prepended to the chat view.
- **Units reversed on history prepend** — Prepending messages to the session history no longer reverses their internal unit order.
- **Definition lists excluded from action suggestions** — HTML definition lists in assistant replies no longer produce spurious action chips.
- **`thinkingInProgress` localized** — The "thinking in progress" label now respects your UI language (ja, ko, zh-cn, zh-tw).
- **Web agent prompts when search unavailable** — Web agent system prompts now skip search-related instructions when no search tool is configured.
- **Scroll position on long streaming messages** — The scroll position is now preserved during long streaming replies instead of jumping around.
- **Structured block stripped from copied messages** — Copying a message no longer includes internal structured blocks meant for the model's eyes only.

---

## 1.3.3

### What's new

- **Anthropic (Claude) provider** — Claude models are now supported as a first-class provider. Configure your API key and start chatting with Claude directly.
- **Vendor logos & model icons** — Provider logos (OpenAI, Anthropic, Google, etc.) and per-model icons (Gemma, GLM, etc.) now appear in the profile selector for quick visual identification.
- **Save-as-note directory setting** — Instead of a modal every time you save assistant output, configure a default directory under **Settings → Note Mate → General** and notes are saved there without extra clicks.

### Refinements

- **Localized insight deepen prompt** — The "deepen insight" prompt now respects your UI language.
- **Internal cleanup** — Shared UI helpers (chip/badge mixins, BubbleListController, SessionStatusController, action-bar/dropdown) are extracted into reusable modules, reducing code duplication.

### Fixes

- **trimTail on mobile** — Action bars detached from message bubbles no longer cause trimTail to over-prune the chat view.
- **Level-2+ summary merge** — Deep summary chains and tool result walks now merge correctly, preventing stale context from being dropped during compression.

---

## 1.3.2

### What's new

- **Embedding provider dropdown** — The embedding toggle is now a dropdown that includes a **None** option, making it clearer when embeddings are disabled and what provider is active.
- **Hover action bar on user messages** — Edit and delete actions now appear as a hover bar on your own messages, replacing the old right-click context menu for a quicker, more discoverable experience.
- **Edit message** — Click the pencil icon on any user message to edit its text and re-send, fixing typos or adjusting your prompt without copy-paste gymnastics.
- **Auto-trim oldest bubbles** — When a conversation grows long, the oldest rendered message bubbles are automatically trimmed to keep the UI responsive. Scroll history and all data are preserved—only the DOM is pruned.
- **Copy button on delegate inputs** — Handoff payloads in delegate task bubbles now show a copy button, so you can grab structured data with one click.
- **Accept all checkpoints** — A new button in the checkpoint toolbar accepts every pending edit checkpoint at once, saving clicks when reviewing a batch of edits you trust.
- **Config selectors moved to General** — Text Generation and Image generation profile pickers now live under **Settings → Note Mate → General**, putting your most-used controls on the first settings page.
- **Custom menu path moved to General** — The MENU.md file path setting is also now under **Settings → Note Mate → General** instead of the old Customize section.

### Refinements

- **"Text Generation" everywhere** — What was previously called "Profile" or "Provider Profile" is now consistently labelled **Text Generation** across settings, dropdowns, and internal APIs (`TextGenConfig`). The i18n keys are consolidated so translations stay in sync.
- **Settings restructured** — Template preview is now in a modal instead of an inline panel, section IDs are centralized, and the settings tab layout is reordered for a smoother navigation flow.
- **Shared UI utilities** — Collapsible sections and copy buttons are extracted into reusable components, reducing duplicated code across the session view, checkpoints, and other panels.
- **Targeted settings refresh** — The settings panel now responds to a focused `onProfilesChanged` callback instead of a broad `refreshAll`, so profile list changes don't trigger unnecessary full re-renders.

### Fixes

- **Touch device delete** — The delete button on message bubbles is now always shown on touch devices where hover isn't available, so you can remove messages on mobile.
- **Message editing guard** — Editing a user message now always opens the edit input first, instead of sometimes re-sending immediately on click.
- **Double-serialised replacements** — An edge case where the edit history could incorrectly nest `replacements` arrays on reload is now handled gracefully.

---

## 1.3.1

### What's new

- **Tag tools split into add / remove / set** — The single `edit_files_tags` tool is now three focused tools: `add_files_tags`, `remove_files_tags`, and `set_files_tags`. Each does one thing well, reducing ambiguity when the model wants to tweak tags without replacing the whole list.
- **Display names in file reference chips** — File chips in the chat now show a display name (the note title) alongside the path, making them easier to scan at a glance.
- **Pending checkpoint badge** — The session switcher button now shows a badge when the current session has un-reviewed checkpoints, so you won't miss a pending edit review.
- **Artifact promotion for oversized sub-agent results** — When a sub-agent returns text too large to inline in the conversation, it is automatically promoted to the artifact store for persistent access across reloads.
- **Handoff keys enforced** — Sub-agent handoff now requires explicit key–value pairs rather than freeform prose, preventing the model from burying structured data in natural-language descriptions.
- **Image generation onboarding tip** — A new tip surfaces when an image-generation profile is configured and the active note has no images.

### Refinements

- **Settings restructured** — The MCP section is renamed to **Tools** and now hosts both MCP servers and the web upload toggle. Tool-related settings that were scattered across other sections are consolidated here. The skill modal is extracted into its own dedicated component.
- **Web fetcher streamlined** — The `web_fetch` tool now returns a cleaner single-page view with inline links instead of a multi-section dump.
- **Edit history polish** — Template preview is now available in the edit history view, and the overall layout is simplified for easier scanning.
- **Session status relocated** — The "Compressing context…" label now lives in the model's thinking row instead of the header, reducing visual noise.

### Fixes

- **Session title language** — Auto-generated titles no longer default to English when the conversation is in another language. The title prompt now enforces the same language as the user's messages.
- **Title generation timing** — Titles are now generated after the first user message rather than mid-stream, avoiding early guesses based on incomplete context.
- **Insights button hidden during streaming** — The **Extract insights** button no longer appears while the assistant is still generating a reply, preventing accidental clicks on stale context.
- **File reference chip icon** — The "add file reference" chip now uses a bracket icon (`[]`) instead of the previous ambiguous symbol.
- **`replace` operation aliases** — The `start` / `end` parameter names are now accepted as aliases in `edit_lines`, so the model's natural tendency to use these terms no longer causes failures.

---

## 1.3.0

### What's new

- **Custom right-click menu from a vault note** — Define your own AI actions in a vault note (`MENU.md` by default) and they appear in the right-click menu under an **AI** submenu on both files and the editor. Each `##` heading becomes a menu label; the body text is a prompt template with `{{filepath}}`, `{{selection}}`, and `{{blockquote}}` variables filled at click time. Add a `[icon]` suffix to any H2 heading (e.g. `[wand-2]`, `[languages]`) to set a Lucide icon for that entry. Blockquote lines (`> ...`) are treated as private comments and stripped before the prompt is sent. Manage everything under **Settings → Note Mate → Customize**, where a dual-action button creates the note from a default template or opens the existing one.

### Refinements

- **Shorter setting labels** — "Image generation" → "Image" and "MCP Servers" → "MCP" in settings navigation for a cleaner sidebar layout.

### Removed

- **Built-in "Explain" and "Polish selection"** — Both are now covered by the default custom menu template. The explain menu item and polish edit action have been removed; the default `MENU.md` template includes equivalent entries so you still get the same behaviour out of the box.

### Fixes

- **Wiki-link chips with references** — Chips for paths like `[[Note#heading]]` or `[[Note^block]]` now correctly resolve to the file instead of treating the heading/block suffix as part of the filename.

---

## 1.2.10

### What's new

- **Template instantiation tool** — A new `instantiate_template` tool lets the model create notes from your vault templates. Built-in variables like `{{date}}`, `{{time}}`, `{{title}}`, `{{yesterday}}`, and `{{tomorrow}}` are resolved deterministically (no LLM involvement in substitution), and you can pass custom `{{key}}` → value pairs. This eliminates the "LLM missed a variable" and "LLM hallucinated extra content" failure modes that plague manual template workflows.

- **Built-in web upload tool** — A new `web_upload_file` tool lets the model upload vault files to external URLs (e.g., temporary sharing services). Disabled by default — enable it under **Settings → Note Mate → Builtin**.

### Refinements

- **Long conversations load on demand** — Session messages now stream in progressively instead of rendering all at once, keeping the UI responsive even after hundreds of turns.

- **Smarter web agent prompts** — Web agent system prompts now adapt dynamically: when the model has no search tool configured, the agent skips search-related instructions entirely, avoiding misleading guidance.

- **Sensitive headers redacted** — Tool call headers that may contain API keys or other sensitive data are now stripped before messages are persisted to disk or included in future turns.

- **RSS per-turn budgets** — The `rss_fetch_feed` tool now respects the same per-turn call budget mechanism used by other tools, preventing runaway feed crawling in a single turn.

- **Capabilities selector removed** — The session toolbar no longer shows the manual capabilities picker. All available tools are always exposed to the model, simplifying the UI.

### Fixes

- **Auto-scroll reliability** — Auto-follow now handles oversized messages gracefully instead of losing its position, and programmatic scrolling avoids triggering unnecessary layout recalculations.

- **Touch scrolling on mobile** — Upward scroll gestures no longer interfere with auto-follow, so you can scroll back through the conversation without the view snapping back down.

---

## 1.2.9

### What's new

- **Context usage at a glance** — A ring indicator in the session header shows how much of your model's context window is in use, with live percentage and token estimates as the conversation grows. A "Compressing context…" label appears while the reducer is working so you know why the assistant pauses briefly.

- **Smarter sub-agent routing** — Sub-agents are now ranked per-turn by the same hybrid BM25 + embedding retriever that powers tools and skills, so only the most relevant ones appear in the delegation block and the `delegate_task` tool's agent list. A new **Sub-agent retriever: top-K** setting (under **Settings → Note Mate → Embedding**) controls how many surface. Sub-agents already used earlier in the conversation stay listed regardless ("sticky on history"), so context for multi-step delegated tasks isn't lost between turns.

- **Artifacts survive reload** — Large sub-agent results (artifacts) are now persisted to disk via Obsidian's DataAdapter, so they survive plugin reload and Obsidian restart. Previously artifacts were in-memory only and disappeared when a session was reloaded.

### Refinements

- **Adaptive compression threshold** — The default context compression threshold now scales with your model's reported context window (~45%) instead of a fixed 48k. For a 1M-token model the no-compression headroom expands to ~375k estimated tokens, meaning far fewer unnecessary compressions on large-context models. Custom profile overrides still take precedence.

- **Better token estimation** — The token estimator is more accurate across content types (system prompts, tool schemas, messages) so the context reducer makes more reliable compression decisions.

- **`grep_file` gains section scoping** — `grep_file` now accepts an optional `heading_path` to restrict the search to a single section, matching the scoping behaviour of `read_section` and `replace_text`. Gracefully accepts common model aliases (`heading`, `headings`).

- **Metadata now includes line count** — `get_metadata` returns `totalLines` for each file, giving the model a quick sense of file size before reading.

- **Clearer handoff naming** — The sub-agent data-passing mechanism is renamed from "exchange" to "handoff" throughout (tool names, internal APIs, prompts). The `delegate_task` parameter is now `handoff` instead of `exchange` — existing sessions are backward-compatible.

- **Editing tools renamed for clarity** — `edit_frontmatter` → `edit_files_frontmatter`, `edit_file_tags` → `edit_files_tags`, and the `replace_text` parameter `replace` → `replacement` for more self-documenting names.

### Fixes

- **Insight button placement** — The insight button no longer overlaps with adjacent content on narrow cards.

---

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
