import type { ChatMessage } from '../chat-stream';
import type { InsightCardState } from '../insights';

/**
 * Discriminated union of all events that a {@link SessionRuntime} may
 * emit to its attached listener(s).
 *
 * The runtime keeps the IChatAgent's stream of low-level callbacks
 * private; everything the view needs to react to flows through this
 * single channel. This matters because the runtime can outlive the
 * view (background continuation): we need the contract to stay valid
 * even when no listener is attached, so the events are purely data
 * (no DOM refs, no closures that capture view state).
 */
export type RuntimeEvent =
    /** A new turn is starting (chat began streaming). */
    | { type: 'start' }

    /**
     * A main-agent message bubble was created or updated. The runtime
     * never mutates the message before forwarding it.
     */
    | { type: 'message-update'; msg: ChatMessage }

    /**
     * Mirror of `message-update` for messages produced by a sub-agent
     * during a delegate_task invocation. `agentName` identifies which
     * sub-agent emitted it (matches the sub-agent's config name).
     */
    | { type: 'sub-agent-message-update'; agentName: string; msg: ChatMessage }

    /** A tool invocation finished (either auto-allowed or post-approval). */
    | { type: 'tool-call-end' }

    /**
     * The current turn finished cleanly. By the time this fires the
     * runtime has already persisted the session state via
     * SessionManager (see SessionRuntime.handleFinish), so listeners
     * only need to refresh UI — not save anything themselves.
     */
    | { type: 'finish' }

    /** Turn was aborted by the user; `msg` is the abort placeholder/last message. */
    | { type: 'abort'; msg: ChatMessage }

    /** Token usage tallies changed (incremental update). */
    | { type: 'usage-update' }

    /** Provider-side error; the chat is no longer running. */
    | { type: 'error'; err: Error }

    /** Conversation history was compressed by the context reducer this turn. */
    | { type: 'context-compressed' }

    /**
     * Emergency shrink fired this turn — the assembled prompt was still
     * above 1.5× the configured compression threshold even after primary
     * compression, so one or more freshly-returned `tool_result` payloads
     * had to be force-truncated to fit the budget. Listeners typically
     * surface a one-shot Notice ("we trimmed some content this turn —
     * consider raising the threshold or switching to a larger-context
     * model"); the runtime's `hasEmergencyShrunk` flag is used to dedupe.
     */
    | { type: 'emergency-shrink-applied' }

    /**
     * The session's auto-generated title was just persisted. Emitted
     * by the runtime after a successful post-finish title generation
     * pass, so an attached view can refresh its title display. The
     * runtime itself owns the title write — listeners only refresh UI.
     */
    | { type: 'title-updated' }

    /**
     * A tool call is awaiting user confirmation. The runtime has
     * already recorded `messageId → resolve` in its pendingConfirmations
     * map, so listeners only need to render the Allow/Deny UI.
     */
    | { type: 'confirm-tool-call'; messageId: string }

    /**
     * The insight card state changed. Fired by the runtime when an
     * extraction transitions phases (loading → results / empty /
     * error), or when a new turn starts and the previous state is
     * cleared (`state === null`). The runtime keeps the source of
     * truth in `getInsightState()`; this event is just a refresh
     * trigger for attached views.
     *
     * Listeners that miss this event (because no view was attached)
     * can recover the latest state on next attach by calling
     * `SessionRuntime.getInsightState()`. Terminal phases are also
     * persisted into session metadata for cold-load recovery.
     */
    | { type: 'insight-update'; state: InsightCardState | null };

/**
 * Listener signature. Listeners are pure event sinks — they MUST NOT
 * throw (the runtime does not isolate per-listener errors) and MUST NOT
 * mutate the event payload.
 */
export type RuntimeListener = (ev: RuntimeEvent) => void;
