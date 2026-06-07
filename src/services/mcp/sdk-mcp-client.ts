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
// SSE helper for tool call results
// ─────────────────────────────────────────────

/**
 * Read an SSE stream and extract the JSON-RPC result from the first
 * data frame. MCP `tools/call` may return SSE when streaming.
 */
async function readSSEResult(
    body: ReadableStream<Uint8Array>,
): Promise<unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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

                for (const line of frame.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("data: ")) {
                        const jsonStr = trimmed.slice(6);
                        if (!jsonStr || jsonStr === "{}") continue;
                        try {
                            const parsed = JSON.parse(jsonStr) as JsonRpcResponse;
                            // Skip frames without a result (e.g. progress notifications)
                            if (parsed.result !== undefined) {
                                return parseResponse(parsed);
                            }
                        } catch {
                            // keep reading for more frames
                        }
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    throw new Error("MCP tool call returned no result");
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

            const initData: unknown = await initResp.json();
            parseResponse(initData);

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

            const listData: unknown = await listResp.json();
            const listResult = parseResponse(listData) as {
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

        // Parse response: SSE stream or plain JSON
        const contentType = resp.headers.get("Content-Type") ?? "";
        let result: unknown;

        if (contentType.includes("text/event-stream") && resp.body) {
            result = await readSSEResult(resp.body);
        } else {
            const data: unknown = await resp.json();
            result = parseResponse(data);
        }

        // Extract text content from the result
        const toolResult = result as {
            content?: Array<{ type?: string; text?: string }>;
            isError?: boolean;
        };

        if (toolResult.isError) {
            const text = extractText(toolResult.content);
            throw new Error(text || "MCP tool returned an error");
        }

        if (toolResult.content) {
            return extractText(toolResult.content) || JSON.stringify(result);
        }

        // Legacy result format
        return JSON.stringify(
            (result as { toolResult: unknown }).toolResult,
        );
    }

    close(): void {
        this._connected = false;
        this._tools = [];
        this._sessionId = undefined;
        this._url = undefined;
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
