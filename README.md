# Note Mate

A vault-connected sidebar assistant: persistent chat that searches and drafts with you, in-editor rewrite and explain shortcuts, plus checkpoints so you review or rewind AI edits cleanly.

It’s an [Obsidian](https://obsidian.md) plugin. Plug in AI accounts you already use, chat beside your notes, pull in vault context, polish text where the cursor sits, and rewind changes when needed—still inside Obsidian.

## What it does for you

### Deep vault tooling

**Notebook access**

Under **Settings → Note Mate**, turn on the **vault tools** you want (grouped under **tool permissions**). Then the assistant can:

- Open notes by path or wiki link and quote what matters.
- Search by text or tags and follow links between notes.
- Create notes or edit what’s already there—everything stays traceable so you know what shifted.

**Insights**

Controlled separately from vault tooling. After a reply, optional cards surface takeaway angles—new vantage points, sharper questions, hooks worth promoting into notes. The goal is fresher momentum, not circling what you already said.

### Everyday editor shortcuts

Right from the editor:

- **Rewrite selection** — expand, shorten, or polish highlighted text.
- **Explain selection** — ask clearly about confusing passages.
- **Send to AI session** — push the open file—plus cursor or selection—into chat for deeper back-and-forth.
- **AI Edit History** — see AI-driven edits and use checkpoints/history when you need to rewind.

### Models and accounts

Add your own keys: **OpenAI-compatible** endpoints (including OpenAI, Azure OpenAI, and comparable hosts), Google Gemini, and saved **profiles** so switching models isn’t rewriting forms each time.

### Optional extras (when you turn them on)

- **Lookups** — Web search, open a page from a URL, skim feeds—useful for research next to notes.
- **Images** — generate pictures and drop them straight into your vault (provider-dependent).
- **Richer tooling** — connect **MCP** servers for capabilities your admin or community provides.
- **Skills** — reusable instruction packs loaded from folders you choose—great for repeatable workflows.
- **Embeddings** (**experimental**) — connect an embedding provider so **tools** and **skills** can be relevance-ranked before entering the prompt, saving tokens. Vault-wide semantic search is **not** here yet; whole-library search “by meaning” is **planned / TBD**. Expect drift as this settles.
- **Memory** — stash short facts between sessions when you want continuity.
- **JavaScript snippets** (**experimental**) — run short scripts from chat for arithmetic or reshaping pasted text when enabled. Executes through the plugin, **not** a hardened sandbox; expect sizeable shifts between releases.

**Platforms & languages:** Runs on desktop and mobile (**Windows**, **macOS**, **Linux**, **iOS**, **Android**).  
UI copy ships in **English**, **日本語**, **한국어**, **简体中文**, and **繁體中文**—defaults follow locale; overrides live in plugin settings.

## Installation

### Community plugins (recommended)

1. In Obsidian, open **Settings → Community plugins**.
2. Search **Note Mate**, then choose **Install** and **Enable**.

### Manual install

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/ialex32x/ai-note-mate/releases).
2. Inside your vault, create `.obsidian/plugins/ai-note-mate/` if it doesn’t exist.
3. Copy those three files into that folder.
4. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## First-time setup

1. Open **Settings → Note Mate**.
2. Add at least one **Provider profile**: an **OpenAI-compatible** endpoint or Gemini, plus your model and key.
3. Optionally wire integrations—you can skip these until something on the roadmap needs them:
   - **Image generation** — saves generated visuals into your vault when enabled.
   - **Embeddings** (**experimental**) — provider needed for embedding-based **tool/skill** filtering (saves tokens). Not for vault-wide semantic search yet; that mode is **planned / TBD**.
   - **MCP servers** — connect external MCP servers for extra tooling.
   - **Skill folders** — where optional instruction bundles live on disk.
   - **Tool permissions** — fine-grained control over which vault moves the automation may attempt.

## Building from source

For people who want to compile the plugin locally:

- **Needs:** Node.js 18+ and npm.
- **Install:** `npm install`
- **Build:** `npm run build` (or `npm run dev` for watch mode)
- **Checks:** `npm run lint` and `npm run test`

## License

[MIT License](./LICENSE)

## Author

[ialex32x](https://github.com/ialex32x)

## Support

If this plugin helps your daily notes, consider [buying me a coffee](https://buymeacoffee.com/ialex32x).
