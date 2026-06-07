import type { IMCPClient, MCPToolInfo } from './mcp-types';
import { requestUrl } from 'obsidian';

// ─────────────────────────────────────────────
// MCP Protocol Constants
// ─────────────────────────────────────────────

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SESSION_HEADER = "Mcp-Session-Id";

// ─────────────────────────────────────────────
// RequestUrl fetch adapter (unchanged)
// ─────────────────────────────────────────────

/**
 * Creates a fetch-compatible function backed by Obsidian's `requestUrl`.
 */
function createRequestUrlFetch(): (
    url: string | URL,
    init?: RequestInit,
) => Promise<Response> {
    return async (url, init?) => {
        if (init?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const urlStr = url instanceof URL ? url.toString() : url;
        const method = init?.method ?? 'GET';
        const body = init?.body as string | ArrayBuffer | undefined;

        const headers: Record<string, string> = {};
        if (init?.headers) {
            const h = init.headers;
            if (h instanceof Headers) {
                h.forEach((v, k) => { headers[k] = v; });
            } else if (Array.isArray(h)) {
                for (const [k, v] of h) {
                    headers[k] = v;
                }
            } else {
                Object.assign(headers, h);
            }
        }

        const result = await requestUrl({
            url: urlStr,
            method,
            headers,
            body,
            throw: false,
        });

        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(result.arrayBuffer));
                    controller.close();
                },
            }),
            {
                status: result.status,
                statusText: '',
                headers: new Headers(result.headers),
            },
        );
    };
}

// ─────────────────────────────────────────────
// JSON-RPC helpers
// ─────────────────────────────────────────────

interface JsonRpcRequest {
    jsonrpc: string;
    method: string;
    params?: Record<string, unknown>;
    id?: number;
}

interface JsonRpcResponse {
    jsonrpc: string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    id?: number;
}

function makeRequest(
    method: string,
    params?: Record<string, unknown>,
    id?: number,
): JsonRpcRequest {
    const req: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, method };
    if (params) req.params = params;
    if (id !== undefined) req.id = id;
    return req;
}

/**
 * Parse a JSON-RPC response, throwing on protocol-level errors.
 */
function parseResponse(data: unknown): unknown {
    const res = data as JsonRpcResponse;
    if (res.error) {
        throw new Error(
            `MCP error ${res.error.code}: ${res.error.message}`,
        );
    }
    return res.result;
}

// ─────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────

/**
 * Read an MCP response, dispatching by Content-Type.
 *
 * MCP Streamable HTTP servers may return JSON or SSE for ANY endpoint,
 * not just `tools/call`. The SDK handled both; we must do the same.
 *
 * For non-SSE responses, we read the body as TEXT first so we always
 * have a raw copy for diagnostics when JSON-RPC parsing comes up empty.
 */
async function readMCPResult(resp: Response): Promise<unknown> {
    const contentType = resp.headers.get("Content-Type") ?? "";
    console.debug("[mcp] response Content-Type:", contentType);

    if (contentType.includes("text/event-stream") && resp.body) {
        try {
            return await readSSEResult(resp.body);
        } catch (err) {
            // SSE parsing can fail for legitimate reasons (e.g. the server
            // returned a single JSON frame without SSE framing).  Fall
            // through to the text-backed JSON path instead of throwing.
            const rawText = await resp.text().catch(() => "");
            if (rawText) {
                console.debug("[mcp] SSE path failed, trying JSON parse of raw body:", rawText.slice(0, 500));
                try {
                    return parseResponse(JSON.parse(rawText));
                } catch {
                    // Return the raw text so callTool can surface it
                    console.warn("[mcp] SSE + JSON fallback both failed; returning raw text");
                    return rawText;
                }
            }
            throw err;
        }
    }

    // Non-SSE: read raw text FIRST so we never lose the body.
    const rawText = await resp.text();
    console.debug("[mcp] JSON response:", rawText.slice(0, 500));

    try {
        const data = JSON.parse(rawText) as JsonRpcResponse;
        const result = parseResponse(data);
        if (result === undefined) {
            // Valid JSON but no `result` or `error` field — this is
            // a protocol anomaly.  Surface the raw parsed object so
            // callTool can inspect it directly.
            console.warn("[mcp] JSON-RPC response missing result/error field:", rawText.slice(0, 500));
            return data;
        }
        return result;
    } catch {
        // Not valid JSON at all — return the raw text so the caller
        // can still surface useful content (or a helpful error).
        console.warn("[mcp] Non-JSON response, returning raw text:", rawText.slice(0, 500));
        return rawText;
    }
}

/**
 * Read an SSE stream and extract the JSON-RPC result from the first
 * data frame. Skips frames without a `result` field.
 *
 * Per the SSE spec, multi-line values are represented as consecutive
 * `data:` lines within a single event — they must be concatenated with
 * `\n` before parsing.
 */
async function readSSEResult(
    body: ReadableStream<Uint8Array>,
): Promise<unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processFrame = (frame: string): unknown => {
        // Collect ALL `data:` lines (SSE multi-line values)
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
                // Value starts after "data:" — leading space is optional
                const val = trimmed.slice(5).replace(/^ /, "");
                dataLines.push(val);
            }
        }
        if (dataLines.length === 0) return undefined;
        const jsonStr = dataLines.join("\n");
        if (!jsonStr || jsonStr === "{}") return undefined;
        try {
            const parsed = JSON.parse(jsonStr) as JsonRpcResponse;
            console.debug("[mcp] SSE frame parsed, has result:", parsed.result !== undefined, "has error:", parsed.error !== undefined);
            if (parsed.result !== undefined) {
                return parseResponse(parsed);
            }
            console.debug("[mcp] SSE frame skipped (no result):", jsonStr.slice(0, 200));
        } catch (e) {
            console.debug("[mcp] SSE frame JSON parse failed:", jsonStr.slice(0, 200), String(e));
        }
        return undefined;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

            while (true) {
                const frameEnd = buffer.indexOf("\n\n");
                if (frameEnd === -1) break;

                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);

                const result = processFrame(frame);
                if (result !== undefined) return result;
            }
        }

        // Flush trailing frame (may lack final \n\n)
        if (buffer.trim()) {
            const result = processFrame(buffer);
            if (result !== undefined) return result;
        }
    } finally {
        reader.releaseLock();
    }

    const lastBuf = buffer.trim().slice(0, 300);
    throw new Error(
        `MCP tool call returned no result` +
        (lastBuf ? ` (last buffer: ${lastBuf})` : ""),
    );
}

// ─────────────────────────────────────────────
// SdkMCPClient
// ─────────────────────────────────────────────

/**
 * MCP client implementation using raw `window.fetch`.
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0 over HTTP
 * with `Mcp-Session-Id` header for session management). Replaces the
 * `@modelcontextprotocol/sdk` dependency.
 */
export class SdkMCPClient implements IMCPClient {
    private _sessionId?: string;
    private _connected = false;
    private _tools: MCPToolInfo[] = [];
    private _requestId = 0;
    private _fetch: typeof fetch;
    private _url?: string;
    private _apiKey?: string;

    constructor() {
        this._fetch = window.fetch.bind(window);
    }

    get connected() {
        return this._connected;
    }
    get tools() {
        return [...this._tools];
    }

    async connect(
        url: string,
        options?: { apiKey?: string; useRequestUrl?: boolean },
    ): Promise<MCPToolInfo[]> {
        this.close();
        this._url = url;
        this._apiKey = options?.apiKey;

        if (options?.useRequestUrl) {
            this._fetch = createRequestUrlFetch() as unknown as typeof fetch;
        }

        try {
            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                Accept: "text/event-stream, application/json",
            };
            if (options?.apiKey) {
                headers["Authorization"] = `Bearer ${options.apiKey}`;
            }

            // ── Step 1: Initialize ──
            const initReq = makeRequest(
                "initialize",
                {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: "ai-note-mate", version: "1.0.0" },
                },
                1,
            );

            const initResp = await this._fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(initReq),
            });

            if (!initResp.ok) {
                const errBody = await initResp.text().catch(() => "");
                throw new Error(
                    `MCP initialize failed: ${initResp.status} ${errBody}`,
                );
            }

            // Extract session ID from response header
            this._sessionId =
                initResp.headers.get(SESSION_HEADER) ?? undefined;
            if (this._sessionId) {
                headers[SESSION_HEADER] = this._sessionId;
            }

            await readMCPResult(initResp);

            // ── Step 2: Send initialized notification ──
            const notifReq = makeRequest("notifications/initialized");
            await this._fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(notifReq),
            });
            // Notifications receive 202 Accepted with no meaningful body

            // ── Step 3: List tools ──
            const listResp = await this._fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(
                    makeRequest("tools/list", undefined, 2),
                ),
            });

            if (!listResp.ok) {
                const errBody = await listResp.text().catch(() => "");
                throw new Error(
                    `MCP tools/list failed: ${listResp.status} ${errBody}`,
                );
            }

            const listResult = (await readMCPResult(listResp)) as {
                tools?: Array<{
                    name: string;
                    description?: string;
                    inputSchema: Record<string, unknown>;
                }>;
            };

            this._tools = (listResult.tools ?? []).map(normalizeTool);
            this._connected = true;
            return [...this._tools];
        } catch (err) {
            this.close();
            throw err;
        }
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<string> {
        if (!this._connected || !this._url) {
            throw new Error("MCP client not connected");
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
        };
        if (this._apiKey) {
            headers["Authorization"] = `Bearer ${this._apiKey}`;
        }
        if (this._sessionId) {
            headers[SESSION_HEADER] = this._sessionId;
        }

        this._requestId++;
        const resp = await this._fetch(this._url, {
            method: "POST",
            headers,
            body: JSON.stringify(
                makeRequest(
                    "tools/call",
                    { name, arguments: args },
                    this._requestId,
                ),
            ),
            signal,
        });

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            throw new Error(
                `MCP tool call failed: ${resp.status} ${errBody}`,
            );
        }

        const result = await readMCPResult(resp);

        // `readMCPResult` should never return undefined after the text-backed
        // fallback, but keep this as a safety net.
        if (result === undefined) {
            throw new Error("MCP tool call returned empty result");
        }

        // `null` is a valid JSON value — treat as empty content.
        if (result === null) {
            return "null";
        }

        // Raw text fallback: when JSON / SSE parsing failed entirely,
        // readMCPResult returns the raw response body as a string.
        if (typeof result === "string") {
            return result;
        }

        const toolResult = result as {
            content?: Array<{ type?: string; text?: string }>;
            isError?: boolean;
            toolResult?: unknown;
        };

        if (toolResult.isError) {
            const text = extractText(toolResult.content);
            throw new Error(text || "MCP tool returned an error");
        }

        if (toolResult.content) {
            return extractText(toolResult.content) || JSON.stringify(result);
        }

        // Legacy result format
        if (toolResult.toolResult !== undefined) {
            return JSON.stringify(toolResult.toolResult);
        }

        // Last-resort fallback for unexpected result shapes (e.g. a
        // JSON-RPC envelope that bypassed parseResponse, or a non-standard
        // MCP server response).  Stringify the whole thing so the LLM
        // at least sees what the server sent.
        return JSON.stringify(result);
    }

    close(): void {
        this._connected = false;
        this._tools = [];
        this._sessionId = undefined;
        this._url = undefined;
        this._apiKey = undefined;
        this._fetch = window.fetch.bind(window);
    }
}

// ── Helpers ──────────────────────────────────────────

function normalizeTool(raw: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}): MCPToolInfo {
    return {
        name: raw.name ?? "unknown",
        description: raw.description,
        inputSchema: raw.inputSchema ?? { type: "object", properties: {} },
    };
}

interface McpTextContentItem {
    type: "text";
    text?: string;
}

function isTextContentItem(c: unknown): c is McpTextContentItem {
    return (
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text"
    );
}

function hasTextField(c: unknown): c is { text: unknown } {
    return typeof c === "object" && c !== null && "text" in c;
}

/** Extract plain text from MCP content items */
function extractText(content: unknown): string | null {
    if (!content) return null;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(isTextContentItem)
            .map((c) => c.text ?? "")
            .join("\n");
    }
    if (hasTextField(content)) return String(content.text);
    return null;
}
