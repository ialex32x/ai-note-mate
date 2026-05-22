/**
 * recall-artifact-toolcall.ts
 *
 * Built-in tool that lets the MAIN agent re-fetch a sub-agent return
 * value that was parked in the per-session {@link ArtifactStore} —
 * either because it was too large to inline in the `delegate_task`
 * envelope, or because it has since been spilled out by the shrink
 * layer to keep the prompt within budget.
 *
 * Registered ONLY on the main agent. Sub-agents do not see this tool;
 * they communicate upward exclusively via their own handoff store
 * (see handoff-toolcall.ts). If a sub-agent later needs an artifact,
 * the main agent must thread it back into the next `delegate_task`'s
 * `handoff` — see plan §1.4.
 *
 * Storage model: the tool is bound to an `ArtifactStoreSource` —
 * usually a getter `() => ArtifactStore | null` so the long-lived
 * main-agent ChatStream can keep one tool registration across many
 * `prompt()` calls while the orchestrator/runtime owns the actual
 * store instance. Direct binding is also supported for unit tests.
 *
 * Wire shape (plan §1.4):
 *   recall_artifact({ key }) → {
 *     found: boolean,
 *     value?: unknown,         // present iff found && live
 *     evicted?: true,
 *     reason?: "lru" | "ttl" | "too_large_for_store" | "session_end",
 *     size?: number,
 *     available_keys?: string[]   // when !found, helps the LLM self-correct
 *   }
 *
 * Note on `too_large_for_store`: the store itself never tombstones a
 * value with that reason — the marker lives on the envelope. So this
 * tool will only ever surface `lru` / `ttl` / `session_end` from the
 * store's tombstone map; `too_large_for_store` reaches the model only
 * through `envelope.omitted` (handled by the orchestrator).
 */

import type { ArtifactStore } from "../artifact-store";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Either a direct {@link ArtifactStore} (single-execution test fixtures)
 * or a getter that resolves the *current* store at call time. The getter
 * form is what the runtime uses: the main-agent ChatStream is built
 * once but the store may be (re-)created across runtime lifecycles, and
 * the tool registration must always reach the live one.
 *
 * A `null` return from the getter is reported as a clear runtime error
 * to the model rather than a thrown exception — same convention as
 * {@link createHandoffTools}.
 */
export type ArtifactStoreSource = ArtifactStore | (() => ArtifactStore | null);

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_NAME = "recall_artifact";

const TOOL_DESCRIPTION =
    "Recall a value previously parked in the artifact store by a delegate_task " +
    "envelope. Use this when a delegate_task envelope contains an `artifacts` " +
    "entry, when a tool_result has been replaced by an `__artifact_ref` placeholder " +
    "after history compaction, or when an `omitted` field tells you the value was " +
    "spilled into the store. The `key` is the exact string from `artifacts[i].key`, " +
    "`__artifact_ref`, or the omitted-field hint. Do NOT re-call delegate_task just " +
    "to read a value you already had — use this tool. If the artifact has been " +
    "evicted, the response tells you why (`reason`) so you can decide whether to " +
    "re-derive it.";

/**
 * Build the `recall_artifact` tool bound to the given store source.
 *
 * @param source either an {@link ArtifactStore} (single-shot use, e.g.
 *   in tests) or a getter `() => ArtifactStore | null` (production:
 *   tool registered once on a long-lived ChatStream, store owned by
 *   the SessionRuntime).
 */
export function createRecallArtifactTool(source: ArtifactStoreSource): RegisteredTool {
    const resolveStore = typeof source === "function"
        ? source
        : () => source;

    return {
        // The model only calls this when it actually needs an artifact;
        // every turn must NOT receive it as a default tool, otherwise
        // it would clutter the schema list and tempt over-eager use.
        ondemand: true,

        // Pure in-memory bookkeeping — no vault, no network, no exec.
        // No confirmation gate either.
        capabilities: [],
        requiresConfirmation: false,

        schema: {
            type: "function",
            function: {
                name: TOOL_NAME,
                description: TOOL_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "The artifact key to recall. Comes from " +
                                "`envelope.artifacts[i].key`, an `__artifact_ref` " +
                                "placeholder in a stale tool_result, or an explicit " +
                                "hint in `envelope.omitted`. Must be a non-empty string.",
                        },
                    },
                    required: ["key"],
                },
            },
        },

        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const rawKey = args["key"];
            if (typeof rawKey !== "string" || !rawKey.trim()) {
                return errorResult(
                    "`key` is required and must be a non-empty string. " +
                    "Pass the exact artifact key from `envelope.artifacts[i].key` " +
                    "or from an `__artifact_ref` placeholder.",
                );
            }
            const key = rawKey.trim();

            const store = resolveStore();
            if (!store) {
                // Either the runtime has been disposed mid-flight or the
                // tool was registered on a chat that doesn't actually
                // have a store wired (e.g. single-agent mode). Either
                // way, fail loudly so the bug is visible — this should
                // not occur in normal operation.
                return errorResult(
                    "recall_artifact called without an active artifact store. " +
                    "This is an internal bug; no artifacts are currently recoverable. " +
                    "If a delegate_task value is essential, re-delegate the task with " +
                    "a narrower scope.",
                );
            }

            const result = store.get(key);

            if (result.found) {
                // Live hit — return the value verbatim. The store has
                // already refreshed lastAccess as a side-effect of get().
                return {
                    success: true,
                    type: "object",
                    content: {
                        found: true,
                        value: result.value,
                        size: result.size,
                    },
                };
            }

            if (result.evicted) {
                // Tombstone hit — tell the model what happened. We also
                // include `available_keys` so it can pick a different
                // recoverable artifact instead of giving up entirely.
                // This is mildly more chatty than strictly needed but
                // costs ~one short array per call and dramatically
                // shortens the recovery loop on key typos / staleness.
                return {
                    success: true,
                    type: "object",
                    content: {
                        found: false,
                        evicted: true,
                        reason: result.reason,
                        size: result.size,
                        available_keys: store.liveKeys(),
                    },
                };
            }

            // Pure miss — never been stored, or its tombstone aged out
            // of the FIFO-capped tombstone map. From the model's POV
            // these are indistinguishable; we say so.
            return {
                success: true,
                type: "object",
                content: {
                    found: false,
                    evicted: false,
                    available_keys: store.liveKeys(),
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function errorResult(message: string): ToolCallResult {
    return {
        success: false,
        type: "text",
        content: `Error: ${message}`,
    };
}
