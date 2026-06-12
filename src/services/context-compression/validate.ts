import type { HistoryMessage } from "./types";
import { toolResultRunEnd } from "./tool-sequence";

/**
 * End-to-end validation & sanitization of the final messages list sent to the LLM.
 *
 * Unlike `ensureToolSequenceIntegrity` which only inspects a local slice before
 * concatenation, this runs on the fully-assembled message array (system messages,
 * historical summaries, archive notes, and recent messages all combined) so it
 * can catch orphan tool_results that were introduced by the assembly itself
 * (e.g. a synthetic summary `assistant` message sitting immediately before a
 * `tool_result`).
 *
 * Rules enforced (see docs/context-compression-fix-plan.md §4.1):
 *  1. Tool pairing: each `assistant(toolCalls)` must be followed by N matching
 *     `tool_result` messages. Trailing missing results cause the assistant to
 *     degrade to content-only (or be dropped if it would be empty). Middle
 *     missing results get a synthetic placeholder tool_result.
 *  2. Every `tool_result` must have a directly-preceding `assistant(toolCalls)`
 *     (separated only by other tool_results). Otherwise it is an orphan and
 *     dropped.
 *  3. `assistant` messages with empty content, no toolCalls and no
 *     thinkingContent are dropped (some gateways reject them outright).
 *  4. The first non-system message may not be a `tool_result`.
 *
 * The method returns a new array; the input is never mutated.
 */
export function validateAndSanitizeForLLM<T extends HistoryMessage>(messages: T[]): T[] {
    if (messages.length === 0) return messages;

    // Debug: dump the assembled sequence before sanitization so any
    // subsequent 400 can be correlated with the exact layout we produced.
    try {
        const summary = messages.map((m, idx) => {
            const tc = m.toolCalls;
            const tcIds = tc && tc.length > 0 ? tc.map((c) => c.id).join(",") : "";
            const tcId = m.toolCallId;
            const len = typeof m.content === "string" ? m.content.length : 0;
            return `[${idx}] ${m.role}${tcIds ? ` toolCalls=${tcIds}` : ""}${tcId ? ` toolCallId=${tcId}` : ""} len=${len}`;
        }).join("\n");
        console.debug("[ContextCompressor] validate: pre-sanitize sequence\n" + summary);
    } catch { /* noop */ }

    // Pass 1 — drop empty assistant messages & leading orphan tool_results,
    // and drop any tool_result whose owning assistant(toolCalls) is not the
    // nearest non-tool_result predecessor.
    const pass1: T[] = [];
    let sawNonSystem = false;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;

        if (msg.role === "system") {
            pass1.push(msg);
            continue;
        }

        // Drop empty assistant messages that carry no useful payload.
        if (msg.role === "assistant") {
            const toolCalls = msg.toolCalls;
            const hasContent = typeof msg.content === "string" && msg.content.length > 0;
            const hasThinking = typeof msg.thinkingContent === "string" && msg.thinkingContent.length > 0;
            const hasToolCalls = !!(toolCalls && toolCalls.length > 0);
            if (!hasContent && !hasThinking && !hasToolCalls) {
                console.warn("[ContextCompressor] validate: dropping empty assistant message at index", i);
                continue;
            }
        }

        if (msg.role === "tool_result") {
            // First non-system message must not be a tool_result.
            if (!sawNonSystem) {
                console.warn("[ContextCompressor] validate: dropping leading orphan tool_result");
                continue;
            }
            // Find the nearest assistant predecessor already accepted.
            //
            // The walk must step over any message that ChatStream may
            // legitimately interleave inside an assistant→tool_result
            // chain. Today that is:
            //   * sibling `tool_result` messages (the obvious case);
            //   * synthetic `user` messages injected right after a
            //     media-returning tool_result so the LLM can perceive
            //     the bytes (see chat-stream.ts where `mediaAttachment`
            //     is unpacked into `{ role: "user", media: [...] }`).
            //     Without skipping these, every sibling tool_result
            //     from the same assistant turn that happens to sit
            //     AFTER the media-injected user message gets dropped
            //     as an orphan, and pass 2 then fills the gap with a
            //     synthetic "[Error: tool result missing after context
            //     compression]" placeholder. The model reads that as
            //     "my tool call failed" and re-tries the whole batch
            //     on the next iteration — same media tool re-fires,
            //     same orphan-drop happens — which surfaces in the
            //     wild as the agent looping "as if it forgot what it
            //     just did after two steps".
            // Generalising: walk back across non-assistant messages
            // to find the closest assistant, then verify with a
            // toolCallId match. The id-match guard is what keeps this
            // safe — it prevents a stale assistant from a prior turn
            // from being silently re-used as an owner.
            let ownerIdx = pass1.length - 1;
            while (ownerIdx >= 0 && pass1[ownerIdx]!.role !== "assistant") {
                ownerIdx--;
            }
            const owner = ownerIdx >= 0 ? pass1[ownerIdx] : undefined;
            const ownerToolCalls = owner && owner.role === "assistant"
                ? owner.toolCalls
                : undefined;
            const tcId = msg.toolCallId;
            if (!owner || owner.role !== "assistant" || !ownerToolCalls || ownerToolCalls.length === 0
                || !tcId || !ownerToolCalls.some((tc) => tc.id === tcId)) {
                console.warn("[ContextCompressor] validate: dropping orphan tool_result (toolCallId=", tcId, ")");
                continue;
            }
        }

        pass1.push(msg);
        sawNonSystem = true;
    }

    // Pass 2 — for each assistant(toolCalls), verify all required tool_results
    // are present. Fill missing middle ones with a placeholder; trim a trailing
    // assistant(toolCalls) that has NO results at all (or degrade it to
    // content-only if it has usable content).
    const pass2: T[] = [];
    for (let i = 0; i < pass1.length; i++) {
        const msg = pass1[i]!;
        pass2.push(msg);

        if (msg.role !== "assistant") continue;
        const toolCalls = msg.toolCalls;
        if (!toolCalls || toolCalls.length === 0) continue;

        // Collect tool_results owned by `msg`. Walk forward until we
        // hit the next assistant (= start of a new turn) or run out.
        //
        // The walk must look PAST any non-tool_result interjection
        // ChatStream may legitimately emit inside a tool sequence —
        // today that is a synthetic `user` message carrying the
        // bytes of a media-returning tool's output (see chat-stream
        // where `mediaAttachment` is unpacked). Stopping at the
        // first non-tool_result would partition a multi-toolCall
        // batch around that user message and falsely report the
        // tool_results that follow it as "missing", causing
        // pass 2 to splat synthetic "[Error: tool result missing
        // after context compression]" placeholders into the
        // prompt. The model then reads its own tool calls as
        // failed and re-tries the whole batch.
        const gathered = new Map<string, T>();
        const j = toolResultRunEnd(pass1, i);
        for (let k = i + 1; k < j; k++) {
            if (pass1[k]!.role === "tool_result") {
                const tcId = pass1[k]!.toolCallId;
                if (tcId) gathered.set(tcId, pass1[k]!);
            }
        }

        const missing = toolCalls.filter((tc) => !gathered.has(tc.id));
        const isTrailing = j >= pass1.length; // no message follows the (incomplete) sequence

        if (missing.length === 0) continue;

        if (isTrailing) {
            // Trailing assistant(toolCalls) without results → degrade to content-only or drop.
            const hasContent = typeof msg.content === "string" && msg.content.length > 0;
            const hasThinking = typeof msg.thinkingContent === "string" && msg.thinkingContent.length > 0;
            // Drop the already-pushed message; we will re-push the degraded form if useful.
            pass2.pop();
            // Also drop any partial tool_results we just gathered — they are orphans now.
            for (let k = i + 1; k < j; k++) {
                // Nothing to drop from pass2 (we only pushed `msg`). Skip in the outer loop below.
            }
            if (hasContent || hasThinking) {
                // Strip toolCalls so downstream providers don't try to pair them.
                const { toolCalls: _droppedToolCalls, ...rest } = msg;
                void _droppedToolCalls;
                pass2.push(rest as T);
                console.warn("[ContextCompressor] validate: trailing assistant(toolCalls) missing results — degraded to content-only");
            } else {
                console.warn("[ContextCompressor] validate: trailing assistant(toolCalls) missing results and no content — dropped");
            }
            // Skip over the partial tool_results we already consumed.
            i = j - 1;
            continue;
        }

        // Middle gap → insert placeholder tool_results for each missing id,
        // ordered after the present ones to preserve a stable layout.
        for (let k = i + 1; k < j; k++) {
            pass2.push(pass1[k]!);
        }
        for (const mc of missing) {
            const placeholder = {
                role: "tool_result",
                content: "[Error: tool result missing after context compression]",
                toolCallId: mc.id,
            } as unknown as T;
            pass2.push(placeholder);
            console.warn("[ContextCompressor] validate: inserted placeholder tool_result for missing id=", mc.id);
        }
        i = j - 1; // skip consumed results
    }

    return pass2;
}
