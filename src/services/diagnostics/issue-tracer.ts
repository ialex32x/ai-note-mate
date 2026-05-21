/* ─────────────────────────────────────────────
   IssueTracer — in-memory diagnostic breadcrumbs
   ─────────────────────────────────────────────

   Purpose
   -------
   Capture clues from code paths the plugin already KNOWS are buggy /
   unexpected (i.e. anywhere we already had a defensive `console.warn`
   or `console.error` saying "this should not happen — please report").

   The problem this solves
   -----------------------
   On desktop the user can open DevTools and forward us the relevant
   console line. On mobile (iOS / Android) there is no easy way to
   surface that information. Without an in-app channel, the only signal
   we get back is "the tool returned nothing" with no diagnostic clue
   attached, which is exactly the class of bug this exists to debug.

   Deliberate non-goals
   --------------------
   - NOT a generic logger. We do not mirror every `console.warn`. Only
     code paths we have already classified as "this is a known bug / a
     branch that should not be reachable in a healthy run" record here.
   - NOT persisted. The whole point is to give the user a per-session
     breadcrumb trail without writing anything to disk; restart clears
     everything by construction.
   - NOT i18n'd. Records are diagnostic payloads forwarded back to the
     plugin author (typically pasted into a GitHub issue), so stable
     English identifiers + machine-readable context keep the signal
     intact across user locales.

   API shape (intentionally small)
   -------------------------------
   - `recordIssue(input)` — single ingress for call sites.
   - `getSnapshot()` — pull the current ring buffer (UI rendering).
   - `subscribe(listener)` — push notifications (UI badge refresh).
   - `clearIssues()` — user-driven "dismiss everything".
   */

export type IssueSeverity = 'warning' | 'error';

export interface IssueRecord {
    /** Random short id; used as a React-style key in the modal list. */
    id: string;
    /** ms-since-epoch of capture. */
    timestamp: number;
    severity: IssueSeverity;
    /**
     * Short, stable module identifier — e.g. `"chat-stream"` or
     * `"image-toolcall"`. Kept human-readable but constrained so the
     * UI can group/colourise without parsing free text.
     */
    source: string;
    /**
     * Stable, machine-friendly code naming the specific known-bug
     * pattern (e.g. `"stuck-tool-call"`). Independent from the human
     * message so the message can be reworded without breaking
     * downstream grouping.
     */
    code: string;
    /** One-sentence human-readable description, English. */
    message: string;
    /**
     * Optional structured payload (toolName, msgId, file path, etc.).
     * Stored verbatim and serialised as JSON for the modal / copy.
     */
    context?: Record<string, unknown>;
    /**
     * Optional truncated stack trace. Populated for the `'error'`
     * severity; capped at a handful of frames so the buffer footprint
     * stays bounded (see {@link MAX_STACK_FRAMES}).
     */
    stack?: string;
}

export interface IssueTracerSnapshot {
    /** Records in INSERTION order (oldest → newest). */
    issues: IssueRecord[];
    /** Total records dropped due to the FIFO capacity cap. */
    droppedCount: number;
    /** Convenience: equals `issues.length`. */
    activeCount: number;
}

export interface RecordIssueInput {
    severity: IssueSeverity;
    source: string;
    code: string;
    message: string;
    context?: Record<string, unknown>;
    /** Either an Error (stack auto-extracted) or a raw stack string. */
    error?: unknown;
}

export type IssueTracerListener = (snapshot: IssueTracerSnapshot) => void;

/**
 * Hard cap on retained records. Chosen to bound footprint to roughly
 * 100 KB worst case (200 × ~500B). Any record that pushes past the cap
 * evicts the oldest one (FIFO) and bumps {@link IssueTracerSnapshot.droppedCount}
 * so the UI can hint at silent truncation.
 */
const MAX_RECORDS = 200;

/**
 * Stack frames retained when capturing an Error. Two-frame minimum is
 * enough to identify the throw site + its immediate caller in the
 * common case; capping prevents a single failure from inflating its
 * record to multiple KB.
 */
const MAX_STACK_FRAMES = 5;

class IssueTracer {
    private records: IssueRecord[] = [];
    private dropped = 0;
    private readonly listeners = new Set<IssueTracerListener>();
    private nextSeq = 0;

    record(input: RecordIssueInput): IssueRecord {
        const stack = this.extractStack(input.error);
        const rec: IssueRecord = {
            id: this.generateId(),
            timestamp: Date.now(),
            severity: input.severity,
            source: input.source,
            code: input.code,
            message: input.message,
            ...(input.context ? { context: input.context } : {}),
            ...(stack ? { stack } : {}),
        };

        this.records.push(rec);
        if (this.records.length > MAX_RECORDS) {
            const overflow = this.records.length - MAX_RECORDS;
            this.records.splice(0, overflow);
            this.dropped += overflow;
        }

        this.notify();
        return rec;
    }

    getSnapshot(): IssueTracerSnapshot {
        return {
            issues: this.records.slice(),
            droppedCount: this.dropped,
            activeCount: this.records.length,
        };
    }

    clear(): void {
        if (this.records.length === 0 && this.dropped === 0) return;
        this.records = [];
        this.dropped = 0;
        this.notify();
    }

    subscribe(listener: IssueTracerListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(): void {
        // Build the snapshot once and reuse the SAME object across all
        // subscribers in this tick. Listeners that diff snapshots can
        // bail out cheaply, and we avoid N allocations per record.
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (err) {
                // A misbehaving listener must NOT block other
                // listeners or the recording flow itself.
                console.error('[IssueTracer] listener threw:', err);
            }
        }
    }

    private generateId(): string {
        const seq = (this.nextSeq++).toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `iss-${seq}-${rand}`;
    }

    private extractStack(error: unknown): string | undefined {
        if (!error) return undefined;
        let raw: string | undefined;
        if (error instanceof Error && typeof error.stack === 'string') {
            raw = error.stack;
        } else if (typeof error === 'string') {
            raw = error;
        } else {
            return undefined;
        }
        const lines = raw.split('\n').map(l => l.trimEnd()).filter(Boolean);
        // Most engines put the message on line 0 and frames on lines
        // 1..n. Keep the message line plus a bounded slice of frames.
        if (lines.length <= 1 + MAX_STACK_FRAMES) return lines.join('\n');
        return [
            ...lines.slice(0, 1 + MAX_STACK_FRAMES),
            `… (${lines.length - 1 - MAX_STACK_FRAMES} more frames truncated)`,
        ].join('\n');
    }
}

// ─────────────────────────────────────────────
// Process-wide singleton
// ─────────────────────────────────────────────

let instance: IssueTracer | null = null;

function getInstance(): IssueTracer {
    if (!instance) instance = new IssueTracer();
    return instance;
}

/** Capture a clue. Safe to call from any code path; never throws. */
export function recordIssue(input: RecordIssueInput): IssueRecord {
    return getInstance().record(input);
}

/** Snapshot for synchronous reads (modal render, copy-to-clipboard). */
export function getIssueTracerSnapshot(): IssueTracerSnapshot {
    return getInstance().getSnapshot();
}

/** Subscribe to change events. Returns an `unsubscribe()` function. */
export function subscribeIssueTracer(listener: IssueTracerListener): () => void {
    return getInstance().subscribe(listener);
}

/** Wipe the buffer (user-initiated only — never auto-fire). */
export function clearIssueTracer(): void {
    getInstance().clear();
}

/**
 * Format a snapshot as plain text suitable for pasting into a GitHub
 * issue or chat with the plugin author. Kept here (next to the data
 * model) so any future field addition only has to touch one file.
 */
export function formatSnapshotAsText(snapshot: IssueTracerSnapshot): string {
    const header = [
        `# AI Note Mate — Issue Tracer snapshot`,
        `Captured at: ${new Date().toISOString()}`,
        `Records: ${snapshot.activeCount}` + (snapshot.droppedCount > 0 ? ` (+${snapshot.droppedCount} dropped due to cap)` : ''),
        '',
    ];
    if (snapshot.issues.length === 0) {
        header.push('(no issues recorded)');
        return header.join('\n');
    }
    const body = snapshot.issues.map(formatRecordAsText);
    return [...header, ...body].join('\n');
}

function formatRecordAsText(rec: IssueRecord): string {
    const lines: string[] = [];
    const ts = new Date(rec.timestamp).toISOString();
    lines.push(`## [${rec.severity.toUpperCase()}] ${rec.source} / ${rec.code}`);
    lines.push(`Time: ${ts}`);
    lines.push(`Message: ${rec.message}`);
    if (rec.context && Object.keys(rec.context).length > 0) {
        lines.push('Context:');
        lines.push('```json');
        lines.push(safeStringify(rec.context));
        lines.push('```');
    }
    if (rec.stack) {
        lines.push('Stack:');
        lines.push('```');
        lines.push(rec.stack);
        lines.push('```');
    }
    lines.push('');
    return lines.join('\n');
}

function safeStringify(value: unknown): string {
    // Defensive: context payloads are caller-controlled and may
    // contain cyclic structures (e.g. an Obsidian view reference
    // accidentally captured). Falling back to a flat description
    // beats throwing and losing the whole snapshot.
    try {
        return JSON.stringify(value, replacerWithCycleGuard(), 2);
    } catch (err) {
        return `[unserializable context: ${err instanceof Error ? err.message : String(err)}]`;
    }
}

function replacerWithCycleGuard() {
    const seen = new WeakSet<object>();
    return (_key: string, val: unknown): unknown => {
        if (val && typeof val === 'object') {
            if (seen.has(val)) return '[cyclic]';
            seen.add(val);
        }
        return val;
    };
}
