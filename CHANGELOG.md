# Changelog

## 1.6.2

### What's new

- **Image preview overlay** — Click on any generated image to open a full-screen preview with pinch-to-zoom and pan gestures. Zoom is centered on your finger midpoint for a natural mobile experience, and the gesture state resets cleanly when reopening an image.
- **Mermaid diagram preview & copy** — Mermaid diagrams now open in a full-screen preview overlay, making complex diagrams easier to inspect. A copy button on each diagram lets you grab the source syntax with one click.
- **Generated image thumbnails** — Image generation results now render inline thumbnails in the chat bubble, giving you an immediate visual of what was produced without opening the preview.
- **Per-session persistence** — Session data is now organized into per-session directory files:
  - Messages are stored individually per session, reducing monolithic file writes and improving data integrity.
  - The active session ID is persisted in its own file for faster session resume on restart.
  - Draft input is saved per-session, so un-sent prompts survive across plugin reloads.
  - Insights and follow-up suggestions are persisted per-session, keeping your conversation context intact across restarts.
- **Image quality compression setting** — A new slider under **Settings → Note Mate → Image** lets you control JPEG output quality for generated images, balancing visual fidelity against file size.
- **Vector provider logos** — OpenAI and Claude now display crisp vector logos in the profile selector, matching the visual polish of other provider icons.
- **New model context windows** — Context window definitions have been added for Qwen3.6-Flash, Qwen3.7, Kimi K2.x, and 2026 model variants, ensuring accurate token budgeting for the latest models.

### Refinements

- **Localized rename triggers** — `rename_or_move_file` tool descriptions now have locale-specific triggers across all supported languages, improving the model's ability to use the tool in non-English conversations.
- **Code cleanup** — Removed unnecessary type casts and fixed a typo in internal helpers.

### Fixes

- **History loading near top** — When scrolling near the top of a conversation to load older messages, history chaining now correctly continues instead of stalling at the first batch.
- **License corrected** — The plugin license has been corrected from 0-BSD to MIT.

---

## 1.6.1

### What's new

- **`create_note` replaces `create_file`** — The vault tool has been renamed and now accepts optional `frontmatter`, letting the model create structured notes with tags, aliases, and custom metadata in a single call.
- **Save chat attachments** — The new `save_chat_attachment` tool lets the model save pasted images (and other attachments) from the current user message directly into the vault, making ephemeral paste content persistent without manual steps.
- **Attachment export** — Session export now includes inline image references for pasted attachments, so exported Markdown fully captures the conversation's visual content.
- **Debug mode** — A new toggle in **Settings → Note Mate → Advanced** enables debug features including a **context composition breakdown** that shows per-agent token consumption turn by turn; the breakdown is persisted and survives session reloads.
- **`old_text` / `new_text` aliases** — The `replace_text` tool now accepts `old_text` and `new_text` as parameter aliases, matching the parameter names that models naturally produce.
- **Handoff auto-dispatch** — `write_result` handlers now silently route scalar, array, and object values to the correct typed variant, eliminating failed tool calls when the model uses a mismatched write tool.
- **Sub-agent model name in orchestration** — When delegation resolves a sub-agent's profile, the model name now appears in the orchestration bubble for clearer visibility into which provider handled each sub-task.

### Refinements

- **Leaner system prompts** — The agent system prompt has been condensed by roughly 20%, removing redundant phrasing and consolidating related rules for a tighter token footprint.
- **Unified prompt paths** — Single-agent and multi-agent conversations now share a common prompt assembly path, reducing duplication and making prompt behaviour more predictable across setups.
- **Conditional TODO & memory rules** — TODO and memory prompts are now injected only when the session has active TODO items or slots with memories, saving tokens on simple conversations.
- **Short-query optimisation** — Prompt length and chat-stream schemas are trimmed for short queries, reducing overhead on quick back-and-forth exchanges.
- **Structured follow-ups removed** — The structured follow-up suggestion variant has been retired; the simpler prompt-based follow-up path covers all use cases with less complexity.
- **Settings tab scroll extracted** — The tab bar auto-scroll logic has been moved from the settings-components module into the settings-tab controller for cleaner separation.

### Fixes

- **Whitespace-only chunks filtered** — LLM responses that emit whitespace-only content chunks no longer appear as blank message units in the UI.
- **Duplicate title input guard** — Rapid double-clicking the session title no longer creates duplicate or overlapping edit inputs.
- **Context tooltip always visible** — The compact context usage tooltip now shows reliably in the session status area instead of sometimes being hidden.
- **Token usage tooltip removed** — The token usage tooltip has been removed from the session switcher dropdown to avoid layout disruption.
- **Session dropdown time layout** — The time label in the session switcher dropdown now uses flex layout, fixing alignment issues.
- **Attachment delete button position** — The delete button on pasted attachment thumbnails is now correctly positioned relative to the thumbnail container.
- **Post-compression token breakdown** — The context breakdown now uses token counts after compression, reflecting the actual context window usage.
- **`custom_` prefix stripped from labels** — Sub-agent labels in bubbles no longer show a `custom_` prefix for custom agents, matching the clean display of built-in agents.
- **Settings tab scroll behaviour** — Tab bar scrolling now correctly peeks at neighbouring tabs and responds smoothly to syncing changes.

---

## 1.6.0

### What's new

- **Custom agents (experimental)** — Define your own sub-agents directly in settings. Each custom agent gets an inline system prompt, per-agent profile overrides (choose a different model per agent), and an enable/disable toggle. Built-in agents are now shown in a read-only view so you can see what's available and toggle them individually. *This is an experimental feature and will be refined in future releases.*
- **Image paste & attachment support** — Paste images from the clipboard into the chat input; the plugin now sends them as first-class message content (referencing images from the vault via wikilinks still works as before). Currently limited to one pasted image per message.

### Refinements

- **Leaner tool registration** — Built-in tool registration is now centralised and injected at runtime, and per-agent tool toggles let you control which tools each agent can access.
- **Handoff guidance at runtime** — Sub-agent handoff prompts are now constructed on-the-fly instead of being baked in, giving cleaner separation between agent configuration and prompt assembly.
- **Stable builtin agent keys** — Built-in agent tabs now use stable keys, preventing UI glitches when settings are reloaded.

---

## 1.5.3

### What's new

- **Pinned prompt bar on scroll** — When you scroll up in a conversation, your active prompt is now pinned to the top of the session as a floating bar, so you can reference or adjust it without losing your place.
- **Session loading overlay** — An indeterminate loading overlay now appears when the session cache is being initialised, with improved readiness checks and user notifications so you always know when a session is ready to use.

### Refinements

- **Leaner replace-text** — Text replacement logic has been extracted into a dedicated `replace-normaliser` module, making replacement behaviour more predictable and testable.
- **Session loading deferred** — Session cache initialisation has been deferred and reworked to avoid blocking Obsidian's startup, significantly reducing the plugin's impact on launch time.
- **Bubble iteration robustness** — The bubble list is now converted to a plain array for iteration, eliminating live-collection edge cases during rendering.

### Fixes

- **`end_line` auto-clamping** — When the model specifies an `end_line` exceeding the file's total line count, it is now automatically clamped to the last line instead of throwing an error.
- **TODO task status enforcement** — The system prompt now emphasises updating TODO task status *before* the final reply, reducing stale tasks left behind after a conversation.
- **Quick-ask positioning near bottom** — Quick-ask panels near the bottom of a long conversation now appear above the bubble instead of below, preventing them from being clipped off-screen.
- **Session view alignment** — The session view is now properly center-justified, fixing a layout misalignment.

---

## 1.5.2

### What's new

- **Branching during streaming** — Conversations can now be branched while the assistant is still streaming, letting you fork a new path without waiting for the current reply to finish.

### Refinements

- **Improved LLM editing accuracy and efficiency** — Multiple tool improvements help the LLM edit notes more precisely and efficiently:
  - `insert_text` replaces `edit_lines` with heading-anchored insertion, fuzzy heading matching, and normalized direction arguments for predictable edits.
  - `batch_replace_text` enables multiple text replacements in a single operation; `replace_text` accepts `old`/`new` as parameter aliases.
  - Hash-gated `set_section` prevents accidental overwrites by verifying section content before applying changes.
  - `edit_files_frontmatter` is split into dedicated `batch_set` and `batch_unset` tools for clearer frontmatter manipulation.
  - Section-targeting tools now accept fuzzy heading matches, tolerating minor formatting differences.
  - `occurrence_offset` and `max_replacements` replace `replace_all` and `expected_count` for more intuitive control over text replacement scope.
  - Line endings are normalized and block inserts are auto-padded for cleaner, more consistent edit output.
- **Read section for main agent** — `read_section` is now available to the main agent, no longer restricted to sub-agents.
- **Faster plugin loading** — Session store loading has been refactored to eliminate redundant serialization and reduce startup overhead, significantly improving plugin load speed.

### Fixes

- **Streaming Mermaid deferral** — Mermaid diagrams during streaming are now deferred until the stream completes, preventing rendering glitches from partial diagram syntax.
- **Draft save responsiveness** — Draft save delay has been reduced to 2 seconds, making auto-save feel more responsive during active conversations.

---

## 1.5.1

### What's new

- **Tencent Cloud ASR** — Speech-to-text now supports Tencent Cloud as a provider alongside DashScope, with COS-based upload for large audio files.
- **Disable skills** — Skills can now be disabled via `disable: true` in frontmatter; disabled skills are excluded from the count badge and dimmed in the details modal.
- **Model name on assistant bubbles** — Assistant messages now display the model name that generated the response, giving better visibility into which provider handled each turn.
- **Unread indicator** — The scroll-to-bottom button now shows a visual indicator when new messages are waiting, making it easier to catch up after scrolling away.
- **Search directory scoping** — The `search_content` tool now supports directory-level filtering, letting agents narrow searches to specific vault folders.

### Refinements

- **Localized AGENT.md template** — The default AGENT.md template is now fully localized across all supported languages.
- **Active TODO injection** — Active TODO items from the session are now automatically injected into the system prompt, keeping the agent aware of outstanding tasks.
- **Copy button in model selector** — Model selector items now include a copy button for quickly capturing model identifiers.
- **Leaner chat-stream** — Assistant lifecycle and QuickAsk logic have been extracted out of `chat-stream` into dedicated modules, reducing the core stream module's footprint.
- **Context compression module** — The context reducer has been renamed and reorganized into a clean `context-compression` module with better separation of concerns.
- **Orchestrator decomposition** — Delegate payload construction and handoff seed generation have been extracted from the orchestrator into focused, testable units.

### Fixes

- **Session deletion race** — A race condition when deleting sessions has been resolved, with improved logging for better diagnostics.
- **Concurrent write safety** — Sequential write chaining now prevents concurrent write races that could corrupt session data on disk.
- **Scroll parking** — Manually scrolling up now reliably parks auto-follow, preventing the view from snapping back during streaming.
- **Mermaid overflow** — Long Mermaid diagrams in chat bubbles no longer overflow their containers.
- **Casing conflict detection** — Vault casing conflict checks now handle undefined path segments and correctly scan parent folders.

---

## 1.5.0

### What's new

- **Speech-to-text transcription** — Audio files can now be transcribed directly in sessions via DashScope (Alibaba). Region-based configuration replaces the old base URL approach, and large files are handled with async transcription for reliability.
- **AGENT.md project guidance** — The plugin now reads `AGENT.md` files for per-project AI instructions, replacing the older inline prompt mechanism with a more powerful, file-based approach.

### Refinements

- **"Chat" settings label** — The settings section previously labeled "Text Generation" is now called **Chat**, matching the plugin's primary interaction model.
- **Unified session status** — The context usage ring and session status details have been merged into a single entry, giving a cleaner, consolidated view of session health and token consumption.
- **Locale polish** — Punctuation and line length in localization strings across all supported languages have been standardized.

### Fixes

- **Parked auto-scroll stability** — When auto-follow is parked, scroll trim is now skipped and scroll position is preserved, preventing unwanted jumps during streaming.
- **Flex ordering enforcement** — Insights, follow-up suggestions, and the loader now consistently respect flex ordering, eliminating layout glitches.
- **Upload config removed** — Redundant upload configuration settings have been cleaned up, simplifying the speech-to-text setup.

---

## 1.4.8

### Refinements

- **Leaner fetch resolution** — The `resolve-fetch` utility now always uses `window.fetch` directly, dropping legacy fallback paths for a smaller, simpler bundle.
- **Session delete flow** — Successor session selection on delete is now handled by the navigator, giving cleaner separation between session management and UI navigation.

### Fixes

- **Save metadata serialization** — Session save metadata is now properly serialized with `saveToCache`, preventing potential inconsistencies when session data is written to disk.

---

## 1.4.7

### What's new

- **Generated asset panel** — Session assets (images, etc.) are now collected in a dedicated panel within each session, moved to a top-level field with a redesigned layout.
- **API retry logic** — LLM and image generation requests now automatically retry on failure, improving reliability when services are temporarily unavailable.

### Refinements

- **Session context usage** — The session status area now displays context usage information alongside the existing details.
- **Leaner asset panel** — Asset thumbnails are smaller for a tidier look, and panel disposal is properly handled to avoid stale resources.
- **Style consistency** — Extracted a shared `section-category-title` mixin for more uniform styling across settings sections.
- **Deprecated migration removed** — Old v1-v4 session migration files have been purged, simplifying the codebase.

### Fixes

- **Jump buttons on new message** — Navigation jump buttons now properly refresh when a new user message is added to the session.
- **Deleted asset notice** — The asset panel now shows a clean notice when referenced assets have been deleted.
- **Parked auto-follow** — Follow-up suggestions now respect the parked auto-follow state, preventing unwanted scrolling during streaming.

---

## 1.4.6

### Refinements

- **Shed SDK dependencies** — Removed `@google/genai`, OpenAI, and `@modelcontextprotocol/sdk` packages in favour of direct REST calls and `window.fetch`, making the plugin bundle significantly lighter.
- **Cheerio replaced with built-in DOMParser** — Web scraping no longer depends on cheerio, using the browser-native DOMParser instead for faster parsing and zero extra weight.
- **MCP SSE handling streamlined** — Server-sent event and JSON response parsing is now more robust, with simpler error handling and proper request-ID resets on disconnect.

### Fixes

- **`delete_files` alias support** — The `delete_files` tool now accepts `file_paths` as an argument alias, matching the parameter name some models use naturally.

---

## 1.4.5

### What's new

- **LLM fallback for follow-up suggestions** — When template-based follow-up suggestions don't fire, the plugin now falls back to an LLM-powered generation so you always get relevant prompts to continue the conversation.
- **More follow-up suggestions** — Follow-up suggestion generation has been tuned to produce a wider variety of useful prompts.
- **Embedding token ratio in status** — The embedding status indicator now shows an estimated token ratio alongside the file count, giving you a clearer picture of how much context your embedded notes are consuming.

### Refinements

- **Smarter table blank-line handling** — Table detection now uses a single-pass scan for better performance, and preserves existing blank lines around tables instead of collapsing them.

### Fixes

- **Markdown normalization** — Assistant markdown output is now normalized before final rendering, preventing rendering glitches from model formatting quirks.
- **Lint clean-up** — Removed unnecessary regex escapes and switched to `window.fetch` for broader compatibility.

---

## 1.4.4

### What's new

- **Seedream (Ark) image generation** — ByteDance's Seedream models are now available as a first-class image generation provider via the Ark API. Configure your API key and start generating images with Seedream.
- **Reference image support for Seedream** — When generating with Seedream, you can now provide reference images to guide the output.
- **Doubao & Seed model icon** — ByteDance's Doubao and Seed models now display a dedicated icon in the profile selector, making them easy to spot alongside other providers.

### Fixes

- **Regex mode `old`/`new` parameter remapping** — The `edit_lines` regex mode now correctly handles `old`/`new` as aliases for `pattern`/`replacement`, preventing failures when the model uses these natural parameter names.
- **Streaming table layout stability** — Tables at the end of assistant replies no longer cause layout jumps during streaming, keeping the view steady as content arrives.

---

## 1.4.3

### What's new

- **QuickAsk side-turn** — Continue asking from any assistant reply with a new side-turn prompt, plus a delete button to remove individual turns.
- **Vault-wide tag removal** — `rename_tag` now accepts an empty `new_tag` to remove a tag vault-wide instead of erroring.
- **Checkpoint accordion** — File lists in checkpoint cards now collapse when there are many files, keeping the review view tidy.
- **Cleaner handoff context** — Sub-agent handoff data is now split into seed and result stores to reduce parameter-passing issues with the LLM.

### Fixes

- **Append-file newline** — Content appended to files now auto-prepends a newline when needed, matching what the tool description promises.

---

## 1.4.2

### What's new

- **Regex mode for edits** — `edit_lines` now supports regex matching, so the model can find-and-replace by pattern instead of line numbers.
- **Anthropic extended thinking** — Claude models with extended thinking now get proper token budgets, so long reasoning isn't cut short.
- **Session ID in switcher** — The session dropdown now shows each session's short ID, making it easier to tell conversations apart.

### Refinements

- **Unified navigation** — Message jumping and history loading share a single scroll pipeline, eliminating flickers and improving reliability during streaming.
- **Smoother follow-ups** — Follow-up suggestions behave more predictably while the assistant is still generating a reply.

### Fixes

- **Empty `insert_before`** — Insert-before operations with blank content no longer fail.
- **Missing file as delete** — When Obsidian reports a file with missing content (e.g. sync conflicts), the tool now treats it as deleted instead of throwing.
- **Malformed canvas** — Damaged canvas files are now parsed gracefully instead of crashing.

---

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
