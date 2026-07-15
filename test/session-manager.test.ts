import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/session-manager";
import type { ChatMessage } from "../src/services/chat-stream";

/**
 * Tests for SessionManager focused on persistence safety. The big
 * regression we want to lock down is "creating a new session must not
 * silently destroy the previous active session's persisted history".
 *
 * The vault adapter is mocked with a tiny in-memory key/value store so
 * tests stay synchronous-flavoured (single microtask await) and don't
 * touch the real filesystem. Only the surface SessionManager actually
 * uses (`exists`, `read`, `write`, `mkdir`, `remove`) is implemented.
 */

interface FakeAdapter {
    files: Map<string, string>;
    folders: Set<string>;
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    append(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
}

function makeAdapter(): FakeAdapter {
    const files = new Map<string, string>();
    const folders = new Set<string>([""]);
    return {
        files,
        folders,
        async exists(path: string) {
            return files.has(path) || folders.has(path);
        },
        async read(path: string) {
            const v = files.get(path);
            if (v === undefined) throw new Error(`ENOENT: ${path}`);
            return v;
        },
        async write(path: string, content: string) {
            files.set(path, content);
        },
        async append(path: string, content: string) {
            const existing = files.get(path) ?? '';
            files.set(path, existing + content);
        },
        async mkdir(path: string) {
            folders.add(path);
        },
        async remove(path: string) {
            files.delete(path);
        },
    };
}

function makeApp(adapter: FakeAdapter) {
    return {
        vault: { adapter },
    };
}

function makeManager() {
    const adapter = makeAdapter();
    const app = makeApp(adapter);
    const mgr = new SessionManager(app as never, "sessions");
    return { mgr, adapter };
}

function makeUserMessage(content: string, idSuffix = "u1"): ChatMessage {
    return {
        id: `${Date.now()}-${idSuffix}`,
        role: "user",
        content,
        streaming: false,
        timestamp: Date.now(),
        turn: 1,
    };
}

describe("SessionManager.createSession", () => {
    it("creates a fresh session in addition to the bootstrap one and makes it active", () => {
        const { mgr } = makeManager();
        // Constructor no longer auto-creates a session; explicitly prime one.
        const bootstrapId = mgr.createSession();
        const newId = mgr.createSession();
        expect(newId).not.toBe(bootstrapId);
        expect(mgr.activeSessionId).toBe(newId);
        expect(mgr.sessionCount).toBe(2);
    });

    it("does NOT touch any other session's cached messages or token usage", async () => {
        // Set up: explicitly create an active session "A" with real history.
        const { mgr } = makeManager();
        const sessionAId = mgr.createSession();

        const messages: ChatMessage[] = [
            makeUserMessage("hello", "u1"),
            {
                id: "a1",
                role: "assistant",
                content: "hi there",
                streaming: false,
                timestamp: Date.now(),
                turn: 1,
            },
        ];
        const tokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedPromptTokens: 0 };
        await mgr.saveSession(sessionAId, messages, tokenUsage);

        // Sanity: A's snapshot reflects the saved history.
        const before = mgr.getSessionSync(sessionAId);
        expect(before?.messages.length).toBe(2);
        expect(before?.tokenUsage.totalTokens).toBe(150);

        // Act: create a new session (the new-chat flow).
        const newId = mgr.createSession();
        await mgr.saveMetadata();

        // The previous session's snapshot must be unchanged.
        const after = mgr.getSessionSync(sessionAId);
        expect(after?.messages.length).toBe(2);
        expect(after?.tokenUsage.totalTokens).toBe(150);

        // The new session is active and starts empty.
        expect(mgr.activeSessionId).toBe(newId);
        const newSnap = mgr.getSessionSync(newId);
        expect(newSnap?.messages.length).toBe(0);
        expect(newSnap?.tokenUsage.totalTokens).toBe(0);
    });

    it("after saveToCache, the previous session file on disk still contains its history", async () => {
        const { mgr, adapter } = makeManager();
        // Explicitly create the first session so saveSession / saveToCache
        // have a valid activeSessionId to operate on.
        const sessionAId = mgr.createSession();

        const messages: ChatMessage[] = [
            makeUserMessage("preserve me", "u1"),
        ];
        const tokenUsage = { promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedPromptTokens: 0 };
        await mgr.saveSession(sessionAId, messages, tokenUsage);

        // Simulate the new-chat flow used by SessionView.startNewSession.
        mgr.createSession();
        await mgr.saveMetadata();

        // Flush all loaded sessions to the in-memory adapter.
        await mgr.saveToCache();

        // Messages are stored in JSONL format under the session directory.
        const jsonl = adapter.files.get(`sessions/${sessionAId}/messages.jsonl`);
        expect(jsonl).toBeDefined();
        const lines = jsonl!.trim().split('\n');
        expect(lines.length).toBe(1);
        const msg = JSON.parse(lines[0]!) as ChatMessage;
        expect(msg.content).toBe("preserve me");

        // And the list.json must still record A's token usage.
        const list = JSON.parse(adapter.files.get("sessions/list.json") ?? "{}") as {
            sessions?: Array<{ id: string; tokenUsage: { totalTokens: number } }>;
        };
        const aMeta = list.sessions?.find(s => s.id === sessionAId);
        expect(aMeta?.tokenUsage.totalTokens).toBe(10);
    });
});

describe("SessionManager.loadFromCache", () => {
    it("rehydrates a previously saved session's messages from disk", async () => {
        const { mgr, adapter } = makeManager();
        // Explicitly create the first session so saveToCache has a valid
        // activeSessionId to persist.
        const sessionAId = mgr.createSession();
        const messages: ChatMessage[] = [
            makeUserMessage("round-trip", "u1"),
        ];
        await mgr.saveSession(sessionAId, messages, { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 });
        await mgr.saveToCache();

        // Build a fresh manager pointed at the same adapter.
        const app = { vault: { adapter } };
        const mgr2 = new SessionManager(app as never, "sessions");
        await mgr2.loadFromCache();

        await mgr2.ensureMessagesLoaded(sessionAId);
        const snap = mgr2.getSessionSync(sessionAId);
        expect(snap?.messages.length).toBe(1);
        expect(snap?.messages[0]?.content).toBe("round-trip");
    });

    it("does NOT purge a multi-line JSONL session whose metadata lacks messageVersion", async () => {
        // Regression: an interrupted first turn leaves a multi-line
        // messages.jsonl (user + system 'aborted') and — because list.json
        // was flushed before saveMessages stamped messageVersion — a
        // metadata entry with no `messageVersion`. On the next launch the
        // slow-path used to JSON.parse the whole JSONL file, throw, and
        // purge the session as "corrupt" (deleting messages.jsonl and
        // dropping it from the list). It must now survive.
        const { adapter } = makeManager();

        const sessionId = "session-26";
        // Metadata WITHOUT messageVersion (mirrors the pre-fix on-disk state).
        adapter.files.set("sessions/list.json", JSON.stringify({
            version: 1,
            nextId: 27,
            sessions: [{
                id: sessionId,
                title: "",
                firstUserMessage: "hello",
                tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }],
        }));
        adapter.folders.add(`sessions/${sessionId}`);
        // Two-line JSONL — this is what JSON.parse(wholeFile) chokes on.
        const jsonlPath = `sessions/${sessionId}/messages.jsonl`;
        adapter.files.set(jsonlPath, [
            JSON.stringify({ id: "u1", role: "user", content: "hello", streaming: false, timestamp: 1, turn: 1 }),
            JSON.stringify({ id: "s1", role: "system", content: "aborted", streaming: false, timestamp: 2 }),
        ].join('\n') + '\n');
        adapter.files.set("sessions/active.json", JSON.stringify({ activeSessionId: sessionId }));

        const app = { vault: { adapter } };
        const mgr = new SessionManager(app as never, "sessions");
        await mgr.loadFromCache();

        // The session must still be in the list and its file untouched.
        expect(mgr.getAllSessions().some(s => s.id === sessionId)).toBe(true);
        expect(adapter.files.has(jsonlPath)).toBe(true);

        // And its messages load back intact.
        await mgr.ensureMessagesLoaded(sessionId);
        const snap = mgr.getSessionSync(sessionId);
        expect(snap?.messages.length).toBe(2);
        expect(snap?.messages[0]?.content).toBe("hello");
    });

    it("writes messageVersion into list.json on the very first saveToCache", async () => {
        // The slow-path above only triggers when metadata lacks
        // messageVersion. Guarantee it is present after a single flush so
        // reloads take the fast path (and never risk the purge).
        const { mgr, adapter } = makeManager();
        const sessionId = mgr.createSession();
        await mgr.saveSession(
            sessionId,
            [makeUserMessage("first", "u1")],
            { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 },
        );
        await mgr.saveToCache();

        const list = JSON.parse(adapter.files.get("sessions/list.json") ?? "{}") as {
            sessions?: Array<{ id: string; messageVersion?: number }>;
        };
        const meta = list.sessions?.find(s => s.id === sessionId);
        expect(meta?.messageVersion).toBe(5);
    });
});
