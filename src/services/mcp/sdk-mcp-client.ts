import type { IMCPClient, MCPToolInfo } from './mcp-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requestUrl } from 'obsidian';

/**
 * Creates a fetch-compatible function backed by Obsidian's `requestUrl`.
 *
 * Limitations compared to native fetch:
 * - No streaming: the entire response body is buffered before returning.
 * - No mid-flight abort: `signal` is only checked before the request starts.
 * - SSE responses will be fully buffered until the server closes the connection.
 */
function createRequestUrlFetch(): NonNullable<StreamableHTTPClientTransportOptions['fetch']> {
	return async (url, init?) => {
		// Check abort before starting
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
				for (const [k, v] of h as [string, string][]) {
					headers[k] = v;
				}
			} else {
				Object.assign(headers, h as Record<string, string>);
			}
		}

		const result = await requestUrl({ url: urlStr, method, headers, body, throw: false });

		const bodyStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(result.arrayBuffer));
				controller.close();
			},
		});

		return new Response(bodyStream, {
			status: result.status,
			statusText: '',
			headers: new Headers(result.headers),
		});
	};
}

/**
 * MCP client implementation using the official @modelcontextprotocol/sdk.
 *
 * Uses Streamable HTTP transport which automatically handles both JSON
 * and SSE response formats. No manual SSE parsing needed.
 */
export class SdkMCPClient implements IMCPClient {
	private _client?: Client;
	private _transport?: StreamableHTTPClientTransport;
	private _connected = false;
	private _tools: MCPToolInfo[] = [];

	get connected() { return this._connected; }
	get tools() { return [...this._tools]; }

	async connect(url: string, options?: { apiKey?: string; useRequestUrl?: boolean }): Promise<MCPToolInfo[]> {
		this.close();

		try {
			const headers: Record<string, string> = {
				// Explicitly accept SSE responses
				'Accept': 'text/event-stream, application/json',
			};
			if (options?.apiKey) {
				headers['Authorization'] = `Bearer ${options.apiKey}`;
			}

			const transportOpts: StreamableHTTPClientTransportOptions = {
				requestInit: { headers },
			};

			if (options?.useRequestUrl) {
				transportOpts.fetch = createRequestUrlFetch();
			}

			this._transport = new StreamableHTTPClientTransport(
				new URL(url),
				transportOpts,
			);

			this._client = new Client(
				{ name: 'ai-note-mate', version: '1.0.0' },
				{ capabilities: {} },
			);

			// connect() performs initialize handshake + notifications/initialized
			await this._client.connect(this._transport);

			const result = await this._client.listTools();
			this._tools = (result.tools ?? []).map(normalizeTool);

			this._connected = true;
			return [...this._tools];
		} catch (err) {
			this.close();
			throw err;
		}
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		if (!this._client || !this._connected) {
			throw new Error('MCP client not connected');
		}

		const result = await this._client.callTool(
			{ name, arguments: args },
			undefined,
			{ signal },
		);

		if ('content' in result && result.isError) {
			throw new Error(extractText(result.content) || 'MCP tool returned an error');
		}

		if ('content' in result) {
			return extractText(result.content) || JSON.stringify(result);
		}

		// Compatibility result format (legacy servers)
		return JSON.stringify((result as { toolResult: unknown }).toolResult);
	}

	close(): void {
		this._connected = false;
		this._tools = [];
		if (this._transport) {
			this._transport.close().catch(() => {});
			this._transport = undefined;
		}
		this._client = undefined;
	}
}

// ── Helpers ──────────────────────────────────────────

function normalizeTool(raw: { name: string; description?: string; inputSchema: Record<string, unknown> }): MCPToolInfo {
	return {
		name: raw.name ?? 'unknown',
		description: raw.description,
		inputSchema: raw.inputSchema ?? { type: 'object', properties: {} },
	};
}

/** Extract plain text from MCP content items */
function extractText(content: unknown): string | null {
	if (!content) return null;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === 'text')
			.map((c: any) => c.text ?? '')
			.join('\n');
	}
	if (typeof content === 'object' && 'text' in content) return String((content as any).text);
	return null;
}
