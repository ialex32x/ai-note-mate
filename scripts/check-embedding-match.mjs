// scripts/check-embedding-match.mjs
// Standalone Node.js script (Node 18+, no dependencies).
//
// Usage:
//   node scripts/check-embedding-match.mjs
//
// Optional environment variables:
//   EMBED_URL    (default: http://127.0.0.1:1234/v1/embeddings)
//   EMBED_MODEL  (default: text-embedding-nomic-embed-text-v1.5)
//   EMBED_KEY    (default: empty; local servers usually do not need one)

const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:1234/v1/embeddings";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5";
const EMBED_KEY = process.env.EMBED_KEY ?? "";

// ─── 1. User prompt (same one used in earlier discussion) ────────────────
const userInput =
    "执行一个简单的 JavaScript hello world 代码，输出 \"Hello, World!\" 到控制台。";

// ─── 2. Tool descriptions copied verbatim from the plugin source ─────────
const tools = [
    {
        name: "evaluate_javascript",
        description:
            "Execute a JavaScript code snippet in a sandboxed environment with access to the Obsidian `app` instance. " +
            "The code runs as an async function body with `app` available as a parameter (the Obsidian App object). " +
            "Use `return` to produce a result. The returned value will be serialized as JSON. " +
            "Use this when you need to perform complex vault operations, query metadata cache, " +
            "manipulate the workspace, or do anything that requires direct Obsidian API access " +
            "beyond what other tools provide. " +
            "Examples: `return app.vault.getMarkdownFiles().length;` or " +
            "`const file = app.workspace.getActiveFile(); return file?.path;`",
    },
    // Distractors: clearly unrelated, expected to have lower similarity
    {
        name: "generate_image",
        description:
            "Generate an image from a text prompt using the configured image model. " +
            "Supports DALL-E, gpt-image-1, and other image generation providers.",
    },
    {
        name: "save_long_term_memory",
        description:
            "Store a persistent fact or user preference to long-term memory for use across sessions.",
    },
];

// ─── 3. cosineSimilarity: identical to the plugin's implementation ───────
function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// An equivalent "dot of pre-normalized vectors" implementation,
// used only as a numerical cross-check.
function dotOfNormalized(a, b) {
    let la = 0, lb = 0;
    for (let i = 0; i < a.length; i++) { la += a[i] * a[i]; lb += b[i] * b[i]; }
    la = Math.sqrt(la);
    lb = Math.sqrt(lb);
    if (la === 0 || lb === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += (a[i] / la) * (b[i] / lb);
    return dot;
}

// ─── 4. Call the local embedding server ──────────────────────────────────
async function embed(texts, { batched }) {
    const headers = { "Content-Type": "application/json" };
    if (EMBED_KEY) headers["Authorization"] = `Bearer ${EMBED_KEY}`;

    if (batched) {
        // One request with an array `input` (the plugin's current behavior).
        const resp = await fetch(EMBED_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        const json = await resp.json();
        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        return sorted.map(it => it.embedding);
    } else {
        // One request per text; useful for ruling out "server cannot handle batch".
        const out = [];
        for (const t of texts) {
            const resp = await fetch(EMBED_URL, {
                method: "POST",
                headers,
                body: JSON.stringify({ model: EMBED_MODEL, input: t }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
            const json = await resp.json();
            out.push(json.data[0].embedding);
        }
        return out;
    }
}

// ─── 5. Print diagnostic info for a single vector ────────────────────────
function diagnose(label, vec) {
    const len = vec.length;
    const allFinite = vec.every(Number.isFinite);
    let sumSq = 0;
    let nonZero = 0;
    for (const x of vec) { sumSq += x * x; if (x !== 0) nonZero++; }
    const norm = Math.sqrt(sumSq);
    const head = vec.slice(0, 4).map(x => x.toFixed(6)).join(", ");
    console.log(
        `[${label}] dim=${len} norm=${norm.toFixed(6)} nonZero=${nonZero}/${len} ` +
        `allFinite=${allFinite} head=[${head} ...]`
    );
}

// ─── 6. Main ─────────────────────────────────────────────────────────────
async function run(mode) {
    console.log(`\n===== mode: ${mode} =====`);
    const texts = [userInput, ...tools.map(t => t.description)];
    const vectors = await embed(texts, { batched: mode === "batched" });

    if (vectors.length !== texts.length) {
        console.error(`!! server returned ${vectors.length} vectors for ${texts.length} inputs`);
        return;
    }

    diagnose("userInput", vectors[0]);
    for (let i = 0; i < tools.length; i++) {
        diagnose(tools[i].name, vectors[i + 1]);
    }

    console.log("\nsimilarities (userInput vs each tool description):");
    const rows = tools.map((t, i) => {
        const v = vectors[i + 1];
        return {
            tool: t.name,
            cosine: cosineSimilarity(vectors[0], v).toFixed(4),
            dotNormalized: dotOfNormalized(vectors[0], v).toFixed(4),
        };
    });
    console.table(rows);
}

(async () => {
    try {
        await run("batched"); // Same as plugin: `input` is an array
        await run("single");  // Per-text request; rules out batch-related issues
    } catch (err) {
        console.error("ERROR:", err);
        process.exit(1);
    }
})();
