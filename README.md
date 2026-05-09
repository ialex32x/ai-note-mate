# Note Mate

A powerful AI assistant plugin for [Obsidian](https://obsidian.md) that integrates large language models directly into your knowledge workflow. Chat with AI about your notes, generate content, search the web, create images, and more — all without leaving your vault.

## Features

### Multi-Provider LLM Support

- **OpenAI-compatible** — Works with OpenAI (GPT series), Azure OpenAI, and any API that follows the OpenAI chat completions format.
- **Google Gemini** — Native support for the Gemini API.
- **Multiple profiles** — Configure and switch between different providers/models on the fly.

### Conversational AI Session

- Dedicated sidebar chat view with full Markdown rendering.
- Persistent session history — conversations are saved and searchable across sessions.
- System prompt customization for tailoring AI behavior.
- Streaming responses with thinking/reasoning level control.
- Follow-up suggestion quick-picks for seamless conversation flow.

### Deep Vault Integration

The AI can read, search, browse, and write notes in your vault through a rich set of built-in tools:

- **Read** — Retrieve note content by path or wikilink reference (with line-range support).
- **Search** — Full-text search, tag-based search, and graph traversal across your vault.
- **Write** — Create new notes, append/prepend content, or perform in-place edits.
- **Browse** — List files and folders, explore vault structure.
- **Overview** — Get summaries of vault sections for orientation.
- **Graph** — Traverse backlinks and outgoing links to understand note relationships.

### AI-Powered Editor Actions

- **Rewrite selection** — Expand, shorten, or polish selected text in-place using AI.
- **Explain selection** — Highlight text and ask the AI to explain it.
- **Send to AI Session** — Send file references or editor context (cursor/selection) to the chat for follow-up questions.
- **Edit History** — Track all AI edits with a dedicated history view for review and undo.

### Web Search & Fetch

- Built-in web search with multi-engine scheduling.
- Image search for visual references.
- URL content fetching and extraction (via Cheerio-based HTML parsing).
- RSS feed parsing for staying up to date with external sources.

### Image Generation

- Supports multiple image generation backends:
  - **Gemini** (native image generation)
  - **OpenAI** (DALL·E compatible)
  - **Qwen** (Alibaba Cloud compatible)
- Generated images are saved directly into your vault.

### MCP (Model Context Protocol) Support

- Connect to external MCP servers for extended tool capabilities.
- Configure multiple MCP server endpoints.

### Skills System

- Extensible skill definitions loaded from configurable directories.
- Skills provide domain-specific instructions and tool schemas for the AI.

### Memory

- Persistent key-value memory store that persists across sessions.
- The AI can save and recall facts to maintain long-term context.

### Insight Extraction

- Automatically extract knowledge nuggets from AI conversations.
- Surface reusable insights as preview cards after each assistant reply.

### JavaScript Sandbox

- Execute JavaScript code snippets in a controlled environment.
- Useful for quick calculations or data transformations within a conversation.

### Internationalization

- Full localization support: English, Japanese, Korean, Simplified Chinese, Traditional Chinese.
- Auto-detects system locale with manual override option.

### Cross-Platform

- Works on **Windows**, **macOS**, **Linux**, **iOS**, and **Android**.
- No desktop-only APIs — fully mobile-compatible.

## Installation

### From Community Plugins (Recommended)

1. Open **Settings → Community plugins** in Obsidian.
2. Search for **Note Mate**.
3. Click **Install**, then **Enable**.

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/ialex32x/ai-note-mate/releases).
2. Create a folder at `<YourVault>/.obsidian/plugins/ai-note-mate/`.
3. Copy the downloaded files into that folder.
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Configuration

1. Go to **Settings → Note Mate**.
2. Add at least one **Provider Profile** (OpenAI-compatible or Gemini) with your API key and model.
3. Optionally configure:
   - System prompt
   - Image generation provider
   - Embedding provider for semantic search
   - MCP server connections
   - Skill search paths
   - Tool capability permissions

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Dev (watch mode)

```bash
npm run dev
```

### Lint

```bash
npm run lint
```

### Test

```bash
npm run test
```

## License

[MIT License](./LICENSE)

## Author

*Born from a human-AI collab: I did the prompting, the AI did the coding.* 🙂


[ialex32x](https://github.com/ialex32x)

LLM Models:
- Claude-Opus-4.6
- Claude-Opus-4.7
- GLM-5.1
- DeepSeek-V3.1
- Kimi-2.5

## Support 

If you find this plugin useful, consider [buying me a coffee](https://buymeacoffee.com/ialex32x).
