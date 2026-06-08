import { describe, it, expect } from 'vitest';
import {
    createTodoTool,
    type TodoStateSource,
    type TodoStateInputItem,
} from '../src/services/tools/todo-toolcall';
import {
    emptyTodoState,
    type TodoItem,
    type TodoState,
} from '../src/services/tools/todo-state';
import type { ChatStream, ToolCallResult } from '../src/services/chat-stream';
import { SessionManager } from '../src/session-manager';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory TodoStateSource used by the exec-level tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory implementation of {@link TodoStateSource}. Mirrors
 * the relevant subset of SessionRuntime's behaviour (deterministic
 * timestamps, defensive copying) so the tool can be exercised without
 * spinning up a full runtime.
 */
function makeSource(initial: TodoState = emptyTodoState()): TodoStateSource & {
    /** Number of times any mutating method was invoked (for emit counting). */
    mutations: number;
    /** Last snapshot returned by a mutation (for assertion convenience). */
    lastSnapshot: TodoState | null;
} {
    let state: TodoState = {
        items: initial.items.map(item => ({ ...item })),
        updatedAt: initial.updatedAt,
    };
    let mutations = 0;
    let lastSnapshot: TodoState | null = null;
    let clock = 1000; // monotonic fake timestamp

    function bump(next: TodoState) {
        state = next;
        mutations++;
        lastSnapshot = next;
    }

    return {
        get mutations() { return mutations; },
        get lastSnapshot() { return lastSnapshot; },
        get: () => state,
        replaceAll: (items: TodoStateInputItem[]) => {
            const now = ++clock;
            const next: TodoState = {
                items: items.map(it => ({
                    id: it.id,
                    brief: it.brief,
                    content: it.content,
                    status: it.status ?? 'pending',
                    createdAt: now,
                    updatedAt: now,
                })),
                updatedAt: now,
            };
            bump(next);
            return next;
        },
        update: (id, patch) => {
            const idx = state.items.findIndex(i => i.id === id);
            if (idx < 0) return null;
            const now = ++clock;
            const current = state.items[idx]!;
            const nextItem: TodoItem = {
                ...current,
                ...(patch.status !== undefined ? { status: patch.status } : {}),
                ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
                ...(patch.content !== undefined ? { content: patch.content } : {}),
                updatedAt: now,
            };
            const items = state.items.slice();
            items[idx] = nextItem;
            const next = { items, updatedAt: now };
            bump(next);
            return next;
        },
        clear: () => {
            const next = emptyTodoState();
            bump(next);
            return next;
        },
    };
}

async function run(
    src: TodoStateSource,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    const tool = createTodoTool(src);
    return tool.exec(undefined as unknown as ChatStream, args, undefined as unknown as AbortSignal);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory vault adapter for SessionManager round-trip tests
// ─────────────────────────────────────────────────────────────────────────────

interface FakeAdapter {
    files: Map<string, string>;
    folders: Set<string>;
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
}

function makeAdapter(): FakeAdapter {
    const files = new Map<string, string>();
    const folders = new Set<string>(['']);
    return {
        files,
        folders,
        async exists(path) { return files.has(path) || folders.has(path); },
        async read(path) {
            const v = files.get(path);
            if (v === undefined) throw new Error(`ENOENT: ${path}`);
            return v;
        },
        async write(path, content) { files.set(path, content); },
        async mkdir(path) { folders.add(path); },
        async remove(path) { files.delete(path); },
    };
}

function makeManager(): { mgr: SessionManager; adapter: FakeAdapter } {
    const adapter = makeAdapter();
    const app = { vault: { adapter } };
    const mgr = new SessionManager(app as never, 'sessions');
    return { mgr, adapter };
}

// ─────────────────────────────────────────────────────────────────────────────
// createTodoTool — action: write
// ─────────────────────────────────────────────────────────────────────────────

describe('manage_todos: write', () => {
    it('replaces the list and returns the full snapshot with both fields', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'First step', content: 'Detail for step A: do X in file Y, success when Z.' },
                { id: 'b', brief: '第二步', content: 'Detail for step B: do P then Q.' },
            ],
        });

        expect(result.success).toBe(true);
        expect(result.type).toBe('object');
        const payload = result.content as {
            todos: Array<{ id: string; brief: string; content: string; status: string }>;
            summary: string;
        };
        expect(payload.todos).toHaveLength(2);
        expect(payload.todos[0]!.id).toBe('a');
        expect(payload.todos[0]!.brief).toBe('First step');
        expect(payload.todos[0]!.content).toMatch(/Detail for step A/);
        expect(payload.todos[0]!.status).toBe('pending');
        expect(payload.todos[1]!.brief).toBe('第二步');
        expect(payload.summary).toMatch(/Wrote 2/);

        expect(src.get().items).toHaveLength(2);
        expect(src.mutations).toBe(1);
    });

    it('rejects an empty items array (use clear instead)', async () => {
        const src = makeSource();
        const result = await run(src, { action: 'write', items: [] });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/at least one entry/);
        expect(src.mutations).toBe(0);
    });

    it('rejects duplicate ids', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [
                { id: 'x', brief: 'one', content: 'detail one' },
                { id: 'x', brief: 'two', content: 'detail two' },
            ],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/Duplicate id/);
        expect(src.mutations).toBe(0);
    });

    it('rejects entries missing brief', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [{ id: 'a', content: 'detail only' }],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/brief must be a non-empty string/);
    });

    it('rejects entries missing content', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'brief only' }],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/content must be a non-empty string/);
    });

    it('rejects brief over the 80-character cap', async () => {
        const src = makeSource();
        const longBrief = 'x'.repeat(81);
        const result = await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: longBrief, content: 'ok detail' }],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/brief exceeds 80 characters/);
    });

    it('rejects content over the 700-character cap', async () => {
        const src = makeSource();
        const longContent = 'x'.repeat(701);
        const result = await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'ok', content: longContent }],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/content exceeds 700 characters/);
    });

    it('rejects unknown status values', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'go', content: 'do the thing', status: 'in-progress' }],
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/status must be one of/);
    });

    it('warns (but still writes) when more than one item is in_progress', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'one', content: 'detail one', status: 'in_progress' },
                { id: 'b', brief: 'two', content: 'detail two', status: 'in_progress' },
            ],
        });
        expect(result.success).toBe(true);
        const payload = result.content as { summary: string };
        expect(payload.summary).toMatch(/2 items are marked in_progress/);
        expect(src.get().items).toHaveLength(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTodoTool — action: update
// ─────────────────────────────────────────────────────────────────────────────

describe('manage_todos: update', () => {
    it('patches a single item by id', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'go', content: 'detail for go' }],
        });
        const result = await run(src, {
            action: 'update',
            id: 'a',
            status: 'in_progress',
        });

        expect(result.success).toBe(true);
        const payload = result.content as { todos: Array<{ id: string; status: string }>; summary: string };
        expect(payload.todos[0]!.status).toBe('in_progress');
        expect(payload.summary).toMatch(/in_progress/);
    });

    it('returns a corrective error when id is unknown, listing available ids', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'go', content: 'detail go' },
                { id: 'b', brief: 'stay', content: 'detail stay' },
            ],
        });
        const result = await run(src, {
            action: 'update',
            id: 'missing',
            status: 'completed',
        });

        expect(result.success).toBe(false);
        expect(result.content).toMatch(/No TODO item with id "missing"/);
        expect(result.content).toMatch(/"a"/);
        expect(result.content).toMatch(/"b"/);
    });

    it('updates brief and content independently', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'old brief', content: 'old content' }],
        });
        const result = await run(src, {
            action: 'update',
            id: 'a',
            brief: 'new brief',
            content: 'new content with more detail',
        });
        expect(result.success).toBe(true);
        const payload = result.content as { todos: Array<{ brief: string; content: string }> };
        expect(payload.todos[0]!.brief).toBe('new brief');
        expect(payload.todos[0]!.content).toBe('new content with more detail');
    });

    it('refuses an empty brief on update (brief is required)', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'go', content: 'detail' }],
        });
        const result = await run(src, {
            action: 'update',
            id: 'a',
            brief: '',
        });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/brief.*non-empty string/);
    });

    it('refuses an update with no patch fields', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'go', content: 'detail' }],
        });
        const result = await run(src, { action: 'update', id: 'a' });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/needs at least one/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTodoTool — action: list / clear
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// createTodoTool — response tiering (content omitted for done/cancelled
// items on update / list, kept everywhere on write)
// ─────────────────────────────────────────────────────────────────────────────

describe('manage_todos: response tiering', () => {
    it('write returns full content for every item regardless of status', async () => {
        const src = makeSource();
        const result = await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'pending one', content: 'detail A' },
                { id: 'b', brief: 'already done', content: 'detail B', status: 'completed' },
                { id: 'c', brief: 'cancelled one', content: 'detail C', status: 'cancelled' },
            ],
        });
        expect(result.success).toBe(true);
        const payload = result.content as {
            todos: Array<{ id: string; status: string; content?: string }>;
        };
        // All three items still carry content on write — the model
        // wants confirmation that what it sent landed verbatim.
        expect(payload.todos[0]!.content).toBe('detail A');
        expect(payload.todos[1]!.content).toBe('detail B');
        expect(payload.todos[2]!.content).toBe('detail C');
    });

    it('update strips content on completed/cancelled items while keeping it on active ones', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'active', content: 'detail A — still working on this' },
                { id: 'b', brief: 'finishing', content: 'detail B — about to finish' },
                { id: 'c', brief: 'never needed', content: 'detail C — skipping' },
            ],
        });
        // Mark b as completed and c as cancelled, then probe.
        await run(src, { action: 'update', id: 'b', status: 'completed' });
        const result = await run(src, { action: 'update', id: 'c', status: 'cancelled' });

        expect(result.success).toBe(true);
        const payload = result.content as {
            todos: Array<{ id: string; status: string; brief: string; content?: string }>;
        };
        const byId = Object.fromEntries(payload.todos.map(t => [t.id, t]));
        // Active item still carries content (model may execute it next).
        expect(byId.a!.status).toBe('pending');
        expect(byId.a!.content).toBe('detail A — still working on this');
        // Completed item: brief + status, no content.
        expect(byId.b!.status).toBe('completed');
        expect(byId.b!.brief).toBe('finishing');
        expect(byId.b!.content).toBeUndefined();
        // Cancelled item: brief + status, no content.
        expect(byId.c!.status).toBe('cancelled');
        expect(byId.c!.brief).toBe('never needed');
        expect(byId.c!.content).toBeUndefined();
    });

    it('list strips content on completed/cancelled items the same way update does', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'pending', content: 'detail A' },
                { id: 'b', brief: 'done', content: 'detail B', status: 'completed' },
            ],
        });
        const result = await run(src, { action: 'list' });
        expect(result.success).toBe(true);
        const payload = result.content as {
            todos: Array<{ id: string; status: string; content?: string }>;
        };
        const byId = Object.fromEntries(payload.todos.map(t => [t.id, t]));
        expect(byId.a!.content).toBe('detail A');
        expect(byId.b!.content).toBeUndefined();
    });

    it('list on an all-pending plan returns the same content as the original write', async () => {
        const src = makeSource();
        const writeRes = await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'one', content: 'detail one' },
                { id: 'b', brief: 'two', content: 'detail two' },
            ],
        });
        const listRes = await run(src, { action: 'list' });

        const writePayload = writeRes.content as { todos: Array<{ id: string; content?: string }> };
        const listPayload = listRes.content as { todos: Array<{ id: string; content?: string }> };
        // Both items are still pending → no tiering kicks in, list
        // looks identical to write at this point.
        expect(listPayload.todos.map(t => t.content))
            .toEqual(writePayload.todos.map(t => t.content));
    });
});

describe('manage_todos: list / clear', () => {
    it('list returns the current snapshot without mutating', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [{ id: 'a', brief: 'go', content: 'detail' }],
        });
        const mutationsBefore = src.mutations;
        const result = await run(src, { action: 'list' });
        expect(result.success).toBe(true);
        const payload = result.content as { todos: unknown[]; summary: string };
        expect(payload.todos).toHaveLength(1);
        expect(src.mutations).toBe(mutationsBefore);
    });

    it('list on an empty store reports an empty list rather than failing', async () => {
        const src = makeSource();
        const result = await run(src, { action: 'list' });
        expect(result.success).toBe(true);
        const payload = result.content as { todos: unknown[]; summary: string };
        expect(payload.todos).toHaveLength(0);
        expect(payload.summary).toMatch(/empty/);
    });

    it('clear drops every item', async () => {
        const src = makeSource();
        await run(src, {
            action: 'write',
            items: [
                { id: 'a', brief: 'go', content: 'detail go' },
                { id: 'b', brief: 'stop', content: 'detail stop' },
            ],
        });
        const result = await run(src, { action: 'clear' });
        expect(result.success).toBe(true);
        const payload = result.content as { todos: unknown[]; summary: string };
        expect(payload.todos).toHaveLength(0);
        expect(payload.summary).toMatch(/Cleared 2/);
        expect(src.get().items).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTodoTool — control plane
// ─────────────────────────────────────────────────────────────────────────────

describe('manage_todos: control plane', () => {
    it('rejects an unknown action with a clear message', async () => {
        const src = makeSource();
        const result = await run(src, { action: 'reset' });
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/Unknown action "reset"/);
    });

    it('requires a non-empty action argument', async () => {
        const src = makeSource();
        const result = await run(src, {});
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/`action` is required/);
    });

    it('returns a clear error when the source resolves to null', async () => {
        const tool = createTodoTool(() => null);
        const result = await tool.exec(
            undefined as unknown as ChatStream,
            { action: 'list' },
            undefined as unknown as AbortSignal,
        );
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/outside an active session/);
    });

    it('is registered as always-on and requires no confirmation', () => {
        const tool = createTodoTool(makeSource());
        expect(tool.ondemand).toBe(false);
        expect(tool.requiresConfirmation).toBe(false);
        expect(tool.schema.function.name).toBe('manage_todos');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager round-trip (v4 schema)
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager — TODO state round-trip', () => {
    it('persists v5 and rehydrates todos through saveSession/loadFromCache', async () => {
        const { mgr, adapter } = makeManager();
        const sessionId = mgr.activeSessionId;

        const todos: TodoState = {
            updatedAt: 12345,
            items: [
                {
                    id: 'a',
                    brief: 'First step',
                    content: 'Detail for step A: edit src/foo.ts, check tests pass.',
                    status: 'in_progress',
                    createdAt: 100,
                    updatedAt: 200,
                },
                {
                    id: 'b',
                    brief: '第二步',
                    content: 'Detail for step B: 在 src/bar.ts 添加新接口,success when 调用成功.',
                    status: 'pending',
                    createdAt: 100,
                    updatedAt: 100,
                },
            ],
        };

        await mgr.saveSession(
            sessionId,
            [],
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            undefined,
            undefined,
            undefined,
            todos,
        );
        await mgr.saveToCache();

        // The file on disk should carry version 5 + both brief and content.
        const raw = adapter.files.get(`sessions/${sessionId}.json`);
        expect(raw).toBeDefined();
        const parsed = JSON.parse(raw!) as { version: number; todos?: TodoState };
        expect(parsed.version).toBe(5);
        expect(parsed.todos?.items).toHaveLength(2);
        expect(parsed.todos?.items[1]?.brief).toBe('第二步');
        expect(parsed.todos?.items[1]?.content).toMatch(/在 src\/bar\.ts/);

        // A fresh manager pointed at the same adapter should rehydrate.
        const mgr2 = new SessionManager({ vault: { adapter } } as never, 'sessions');
        await mgr2.loadFromCache();
        await mgr2.ensureMessagesLoaded(sessionId);
        const restored = mgr2.getSessionTodos(sessionId);
        expect(restored?.items).toHaveLength(2);
        expect(restored?.items[0]?.status).toBe('in_progress');
        expect(restored?.items[0]?.brief).toBe('First step');
        expect(restored?.items[1]?.brief).toBe('第二步');
    });

    /**
     * Seed an adapter as if a cold-start were about to happen: write
     * a hand-crafted `list.json` pointing at a single session, plus
     * the corresponding session JSON. Returns a manager bound to that
     * adapter, having gone through `loadFromCache` so the session is
     * actually present in metadata but NOT yet in messagesCache.
     *
     * Necessary because `createSession()` (called from the
     * SessionManager constructor) auto-marks its self-created session
     * as "loaded", which causes `ensureMessagesLoaded` to bail before
     * touching disk — useless for tests that pre-stage a file on
     * disk and expect the loader to pick it up.
     */
    async function seedColdStart(
        sessionId: string,
        sessionFile: Record<string, unknown>,
    ): Promise<{ mgr: SessionManager; adapter: FakeAdapter }> {
        const adapter = makeAdapter();
        const now = Date.now();
        adapter.files.set('sessions/list.json', JSON.stringify({
            version: 1,
            activeSessionId: sessionId,
            nextId: 2,
            sessions: [{
                id: sessionId,
                title: '',
                firstUserMessage: '',
                tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                createdAt: now,
                updatedAt: now,
            }],
        }));
        adapter.files.set(`sessions/${sessionId}.json`, JSON.stringify(sessionFile));
        adapter.folders.add('sessions');

        const mgr = new SessionManager({ vault: { adapter } } as never, 'sessions');
        await mgr.loadFromCache();
        return { mgr, adapter };
    }

    it('purges a v4 session file on load and removes it from metadata', async () => {
        const sessionId = 'session-1';
        const v4File = {
            version: 4,
            id: sessionId,
            messages: [],
            todos: {
                updatedAt: 999,
                items: [
                    {
                        id: 'a',
                        content: 'Plain content only — no displayContent',
                        status: 'pending',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'b',
                        content: 'Machine-side description for b',
                        displayContent: '用户看到的中文摘要',
                        status: 'in_progress',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        };
        const { mgr, adapter } = await seedColdStart(sessionId, v4File);

        await mgr.ensureMessagesLoaded(sessionId);

        // v4 files are purged — TODO state should be undefined.
        expect(mgr.getSessionTodos(sessionId)).toBeUndefined();

        // File should be deleted from disk.
        expect(adapter.files.has(`sessions/${sessionId}.json`)).toBe(false);

        // Metadata should be removed so the session no longer appears in lists.
        const snapshots = mgr.getAllSessions();
        expect(snapshots.find(s => s.id === sessionId)).toBeUndefined();
    });

    it('purges a v4 session with over-long content (no migration attempted)', async () => {
        const sessionId = 'session-1';
        const longContent = 'a'.repeat(300);
        const v4File = {
            version: 4,
            id: sessionId,
            messages: [],
            todos: {
                updatedAt: 1,
                items: [{ id: 'a', content: longContent, status: 'pending', createdAt: 1, updatedAt: 1 }],
            },
        };
        const { mgr, adapter } = await seedColdStart(sessionId, v4File);

        await mgr.ensureMessagesLoaded(sessionId);

        // v4 files are purged — no migration fallback is attempted.
        expect(mgr.getSessionTodos(sessionId)).toBeUndefined();
        expect(adapter.files.has(`sessions/${sessionId}.json`)).toBe(false);
    });

    it('purges v1/v2/v3 files on load and removes from metadata', async () => {
        const sessionId = 'session-1';
        const v2File = {
            version: 2,
            id: sessionId,
            messages: [],
            subAgentMessages: {},
        };
        const { mgr, adapter } = await seedColdStart(sessionId, v2File);

        await mgr.ensureMessagesLoaded(sessionId);

        // v2 files are purged — TODO state should be undefined (no cache entry).
        expect(mgr.getSessionTodos(sessionId)).toBeUndefined();
        // File should be deleted from disk.
        expect(adapter.files.has(`sessions/${sessionId}.json`)).toBe(false);
        // Metadata should be removed.
        const snapshots = mgr.getAllSessions();
        expect(snapshots.find(s => s.id === sessionId)).toBeUndefined();
    });

    it('downgrades the schema version when todos are removed', async () => {
        const { mgr, adapter } = makeManager();
        const sessionId = mgr.activeSessionId;

        // First save: with todos → v5.
        await mgr.saveSession(
            sessionId,
            [],
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            undefined,
            undefined,
            undefined,
            {
                updatedAt: 1,
                items: [{
                    id: 'a',
                    brief: 'go',
                    content: 'detail go',
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        );
        await mgr.saveToCache();
        let parsed = JSON.parse(adapter.files.get(`sessions/${sessionId}.json`)!) as { version: number };
        expect(parsed.version).toBe(5);

        // Second save: clear todos → falls back to v5 (minimum writable version).
        mgr.clearSessionTodos(sessionId);
        await mgr.saveSession(
            sessionId,
            [],
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        );
        await mgr.saveToCache();
        parsed = JSON.parse(adapter.files.get(`sessions/${sessionId}.json`)!) as { version: number; todos?: unknown };
        expect(parsed.version).toBe(5);
        expect(parsed.todos).toBeUndefined();
    });

    it('deleteSession clears the cached TODO state', async () => {
        const { mgr } = makeManager();
        const sessionId = mgr.activeSessionId;

        mgr.setSessionTodos(sessionId, {
            updatedAt: 1,
            items: [{
                id: 'a',
                brief: 'go',
                content: 'detail go',
                status: 'pending',
                createdAt: 1,
                updatedAt: 1,
            }],
        });
        expect(mgr.getSessionTodos(sessionId)?.items).toHaveLength(1);

        await mgr.deleteSession(sessionId);
        expect(mgr.getSessionTodos(sessionId)).toBeUndefined();
    });
});
