/**
 * Heuristic inference of a model's real-token context window from its
 * identifier string.
 *
 * Why this exists
 * ───────────────
 * The context reducer needs a "is this prompt about to blow the model
 * window?" judgement so its {@link ContextReducer.emergencyShrink}
 * safety net can fire **early enough on small-window models** rather
 * than waiting for the generic 1.5× threshold rule to trigger. Without
 * any model-window awareness, the same `compressionThreshold` is
 * applied to a 16k GPT-3.5 profile and a 1M Gemini profile, and the
 * small-window one would 400 long before the safety net engages.
 *
 * Design choice
 * ─────────────
 * - **Regex-based**, not a JSON lookup table. The set of
 *   commonly-used model names is large (~50 base patterns covering
 *   versioned suffixes, regional variants, etc.) but the **base
 *   families** are few (~15). A pattern table degrades gracefully on
 *   unseen versions (e.g. a future `gpt-4o-2026-mini` still matches
 *   `^gpt-4o`).
 * - **No network discovery / no API probing**. The plugin must boot
 *   offline by default (see Developer Policies); also providers
 *   rarely expose this info uniformly (Gemini does, OpenAI doesn't,
 *   Anthropic doesn't, self-hosted varies).
 * - **No user-configurable field** at this layer. The whole point is
 *   "user shouldn't have to know their model's window". A future
 *   advanced-mode `contextWindowOverride` on the profile can override
 *   this if real-world feedback says the heuristic is wrong for some
 *   proxy / fine-tune / exotic setup.
 *
 * Correctness expectations
 * ────────────────────────
 * - **Recoverable when wrong**. If this returns 128k for a model
 *   that's actually 32k, the user will hit emergency shrink on big
 *   turns (or, worst case, a single 400 if they're unlucky). The
 *   inverse case (returns 32k for a 1M model) just means
 *   `emergencyShrink` fires a little earlier than strictly needed.
 *   Neither is catastrophic.
 * - **Conservative fallback**. Unknown model → {@link SAFE_FALLBACK_TOKENS},
 *   a deliberately small number (32k). This errs on the side of
 *   triggering the safety net for unknown models, which is the safer
 *   failure mode.
 * - **Real tokens, not estimated**. Callers convert via the standard
 *   ~1.2× drift factor when comparing against `estimateTokens()` output.
 *
 * Maintenance
 * ───────────
 * - Patterns are intentionally **loose**: a model family typically
 *   ships dozens of dated checkpoints, version suffixes, regional
 *   tags etc. We match the family and accept the common window for
 *   that family; per-checkpoint precision is not worth the upkeep.
 * - When in doubt, **prefer the smaller window** in the table —
 *   under-estimation triggers (harmless) emergency shrink, but
 *   over-estimation can lead to a 400.
 * - Last reviewed: 2026-05 (added DeepSeek V4 1M family). Roughly
 *   once a year: walk through the top-N families on each major
 *   provider's pricing page, update if anything has materially
 *   shifted.
 */

/**
 * Pattern → real-token window mapping. Order matters: the **first**
 * matching pattern wins, so put more specific patterns earlier. Anchoring
 * with `^` is intentional — the model id usually starts with the family
 * name (no provider prefix in this plugin; we apply this after the
 * provider has been resolved separately).
 */
const MODEL_WINDOW_HINTS: ReadonlyArray<readonly [RegExp, number]> = [
    // ── OpenAI ───────────────────────────────────────────────────
    // GPT-4.1 family — 1M-token window (per OpenAI announcement Apr 2025).
    [/^gpt-4\.1/i, 1_000_000],
    // GPT-4o family — 128k.
    [/^gpt-4o/i, 128_000],
    // GPT-4-turbo — 128k.
    [/^gpt-4-turbo/i, 128_000],
    // GPT-4-32k — 32k. Match before the generic `gpt-4` rule below.
    [/^gpt-4-32k/i, 32_000],
    // Legacy GPT-4 (base / dated / 0613 etc.) — 8k.
    [/^gpt-4(?![\d.])/i, 8_000],
    // GPT-3.5-turbo — all current variants are 16k.
    [/^gpt-3\.5/i, 16_000],
    // o-series reasoning models — 200k typical, 128k for `o1-mini`.
    [/^o1-mini/i, 128_000],
    [/^o1/i, 200_000],
    [/^o3-mini/i, 200_000],
    [/^o3/i, 200_000],
    [/^o4/i, 200_000],

    // ── Anthropic ────────────────────────────────────────────────
    // Claude 4.x family — 200k regardless of opus/sonnet/haiku tier.
    [/^claude.*-4/i, 200_000],
    // Claude 3.x family — 200k.
    [/^claude.*-3/i, 200_000],
    // Claude 2.1 — 200k.
    [/^claude-2\.1/i, 200_000],
    // Claude 2 — 100k.
    [/^claude-2/i, 100_000],

    // ── Google Gemini ───────────────────────────────────────────
    // Gemini 1.5 Pro / 2.x / 3.x Pro — 2M (Pro) or 1M (Flash);
    // the table covers both with a safer 1M to avoid over-shooting.
    [/^gemini-(1\.5|2|2\.\d|3|3\.\d).*pro/i, 1_000_000],
    [/^gemini-(1\.5|2|2\.\d|3|3\.\d).*flash/i, 1_000_000],
    // Legacy `gemini-pro` (no version) — 32k.
    [/^gemini-pro/i, 32_000],

    // ── DeepSeek ────────────────────────────────────────────────
    // V4 family (released 2026-04, both Pro and Flash) — 1M context,
    // driven by DSA (sparse attention) so the long-context path is
    // both supported AND cost-effective, unlike V3's 128k cap.
    [/^deepseek-v4/i, 1_000_000],
    // Legacy / aliased endpoints — 128k. Note: `deepseek-chat` and
    // `deepseek-reasoner` are deprecated and scheduled to retire on
    // 2026-07-24; both currently route to `deepseek-v4-flash`. We
    // keep the conservative 128k estimate for these aliased names
    // because (a) the alias contract isn't load-bearing and (b) by
    // the retirement date the names will simply error out, at which
    // point the user must migrate to the explicit `deepseek-v4-*`
    // identifier which the rule above already handles correctly.
    [/^deepseek/i, 128_000],

    // ── Qwen ────────────────────────────────────────────────────
    // Qwen3-coder ships with 256k; we leave it under the 128k bucket
    // anyway because over-shooting is the worse failure mode.
    [/^qwen3/i, 128_000],
    [/^qwen-?2\.5/i, 128_000],
    [/^qwen-?2/i, 32_000],
    // Aliased commercial endpoints (DashScope etc.):
    [/^qwen-turbo/i, 1_000_000],
    [/^qwen-plus/i, 128_000],
    [/^qwen-max/i, 32_000],
    [/^qwen/i, 32_000],

    // ── Moonshot / Kimi ─────────────────────────────────────────
    [/^moonshot-v1-128k/i, 128_000],
    [/^moonshot-v1-32k/i, 32_000],
    [/^moonshot-v1-8k/i, 8_000],
    [/^kimi-?k2/i, 128_000],
    [/^kimi/i, 128_000],
    [/^moonshot/i, 128_000],

    // ── Zhipu GLM ───────────────────────────────────────────────
    [/^glm-4-long/i, 1_000_000],
    [/^glm-4\.5/i, 128_000],
    [/^glm-4/i, 128_000],

    // ── Mistral ────────────────────────────────────────────────
    [/^mistral-large/i, 128_000],
    [/^mistral/i, 32_000],
    [/^codestral/i, 32_000],

    // ── Meta Llama (typically self-hosted / via proxy) ─────────
    [/^llama-?3\.[123]/i, 128_000],
    [/^llama-?3/i, 8_000],
    [/^llama-?2/i, 4_000],
];

/**
 * Fallback for unknown model identifiers. Deliberately small (32k):
 * an under-estimate makes emergency shrink fire more often (loss of
 * a bit of context fidelity, recoverable via the artifact store);
 * an over-estimate can lead to a hard 400 from the provider.
 */
export const SAFE_FALLBACK_TOKENS = 32_000;

/**
 * Look up the real-token context window for `model`.
 *
 * @param model The raw model identifier as stored on the profile
 *              (e.g. `"deepseek-chat"`, `"gpt-4o-2024-08-06"`).
 * @returns The window size in **real** tokens, or
 *          {@link SAFE_FALLBACK_TOKENS} when no pattern matches.
 *          Always positive.
 */
export function inferModelContextWindow(model: string): number {
    if (typeof model !== "string" || model.length === 0) {
        return SAFE_FALLBACK_TOKENS;
    }
    const cleaned = model.trim();
    if (cleaned.length === 0) return SAFE_FALLBACK_TOKENS;

    for (const [re, n] of MODEL_WINDOW_HINTS) {
        if (re.test(cleaned)) return n;
    }
    return SAFE_FALLBACK_TOKENS;
}
