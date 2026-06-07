/**
 * Node.js-based fetch adapter that bypasses CORS restrictions.
 *
 * In Obsidian (both desktop Electron and mobile), `window.fetch` is subject
 * to CORS policy. When a VPN or proxy is active, preflight OPTIONS requests
 * can fail because the server doesn't return CORS headers for the
 * `app://obsidian.md` origin.
 *
 * Node's `https`/`http` modules are NOT subject to CORS. Obsidian provides
 * Node.js built-in modules on both desktop and mobile, so we use them to
 * create a web-standard `Response` with a `ReadableStream` body.
 *
 * Falls back to `window.fetch` if Node.js modules are unavailable (defensive).
 */

/* eslint-disable import/no-nodejs-modules, @typescript-eslint/no-require-imports */

// Node.js globals available in Obsidian runtime (Electron / mobile)
/* global require, Buffer */

// ─────────────────────────────────────────────
// Module availability check (lazy, cached)
// ─────────────────────────────────────────────

let _nodeAvailable: boolean | null = null;

function isNodeAvailable(): boolean {
	if (_nodeAvailable !== null) return _nodeAvailable;
	try {
		require("https");
		require("http");
		_nodeAvailable = true;
	} catch {
		_nodeAvailable = false;
	}
	return _nodeAvailable;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * A `fetch`-compatible function that uses Node.js HTTP(S) modules
 * to bypass CORS restrictions.
 *
 * Returns a web-standard `Response` with a `ReadableStream` body, so it works
 * as a drop-in replacement for `window.fetch` in streaming (SSE) scenarios.
 *
 * @param url  - Request URL (same as `window.fetch`).
 * @param init - Fetch init options (same as `window.fetch`).
 */
export async function corsFreeFetch(
	url: string | URL,
	init?: RequestInit,
): Promise<Response> {
	if (isNodeAvailable()) {
		return nodeFetch(url, init);
	}
	return window.fetch(url, init);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Create a Buffer from a Uint8Array. */
function toBuffer(data: Uint8Array): Buffer {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Dynamically require Node's HTTP modules (only called on desktop). */
function getHttpModules(): {
	http: typeof import("http");
	https: typeof import("https");
} {
	return {
		http: require("http") as typeof import("http"),
		https: require("https") as typeof import("https"),
	};
}

/**
 * Collect all FormData entries into an array of [name, value] pairs.
 * Uses `forEach` since `entries()` is not available in all TS targets.
 */
function collectFormEntries(
	formData: FormData,
): Array<[string, FormDataEntryValue]> {
	const entries: Array<[string, FormDataEntryValue]> = [];
	// FormData.forEach is available at runtime in all Obsidian environments
	// but the TS DOM types may not include it depending on lib target.
	interface FormDataWithForEach {
		forEach(
			callback: (value: FormDataEntryValue, key: string) => void,
		): void;
	}
	(formData as unknown as FormDataWithForEach).forEach(
		(value, key) => {
			entries.push([key, value]);
		},
	);
	return entries;
}

// ─────────────────────────────────────────────
// Multipart form-data builder
// ─────────────────────────────────────────────

/**
 * Build a multipart/form-data body from FormData asynchronously
 * (handles File/Blob entries by reading their ArrayBuffer).
 */
async function buildMultipartBody(
	formData: FormData,
): Promise<{ body: Buffer; contentType: string }> {
	const boundary = `----NodeFetchBoundary${Math.random().toString(36).slice(2)}`;
	const parts: Buffer[] = [];
	const encoder = new TextEncoder();

	const entries = collectFormEntries(formData);

	for (const [name, value] of entries) {
		parts.push(toBuffer(encoder.encode(`--${boundary}\r\n`)));

		if (typeof value === "string") {
			parts.push(
				toBuffer(
					encoder.encode(
						`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
					),
				),
			);
		} else {
			// File/Blob entry
			const file = value;
			parts.push(
				toBuffer(
					encoder.encode(
						`Content-Disposition: form-data; name="${name}"; filename="${file.name || "blob"}"\r\n` +
							`Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
					),
				),
			);
			// Append the file content
			const fileBytes = await file.arrayBuffer();
			parts.push(Buffer.from(fileBytes));
			parts.push(toBuffer(encoder.encode("\r\n")));
		}
	}

	parts.push(toBuffer(encoder.encode(`--${boundary}--\r\n`)));

	return {
		body: Buffer.concat(parts),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

// ─────────────────────────────────────────────
// Node.js request implementation
// ─────────────────────────────────────────────

/**
 * Internal: make a request using Node's http/https module and return a
 * web-standard `Response` with a `ReadableStream` body.
 */
async function nodeFetch(
	url: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const { http, https } = getHttpModules();
	const urlStr = typeof url === "string" ? url : url.href;
	const parsedUrl = new URL(urlStr);
	const isHttps = parsedUrl.protocol === "https:";
	const httpModule = isHttps ? https : http;

	const method = init?.method ?? "GET";

	// Convert headers to a plain object
	const headers: Record<string, string> = {};
	if (init?.headers) {
		if (init.headers instanceof Headers) {
			init.headers.forEach((value, key) => {
				headers[key] = value;
			});
		} else if (Array.isArray(init.headers)) {
			for (const [key, value] of init.headers) {
				headers[key] = value;
			}
		} else {
			for (const [key, value] of Object.entries(init.headers)) {
				headers[key] = value;
			}
		}
	}

	// Prepare body
	let bodyBuffer: string | Buffer | undefined;
	if (init?.body != null) {
		if (typeof init.body === "string") {
			bodyBuffer = init.body;
		} else if (init.body instanceof ArrayBuffer) {
			bodyBuffer = Buffer.from(init.body);
		} else if (ArrayBuffer.isView(init.body)) {
			bodyBuffer = Buffer.from(
				init.body.buffer,
				init.body.byteOffset,
				init.body.byteLength,
			);
		} else if (init.body instanceof FormData) {
			const { body: mpBody, contentType } =
				await buildMultipartBody(init.body);
			bodyBuffer = mpBody;
			headers["Content-Type"] = contentType;
		} else if (init.body instanceof Blob) {
			const ab = await init.body.arrayBuffer();
			bodyBuffer = Buffer.from(ab);
		} else if (init.body instanceof URLSearchParams) {
			bodyBuffer = init.body.toString();
			if (!headers["Content-Type"]) {
				headers["Content-Type"] =
					"application/x-www-form-urlencoded;charset=UTF-8";
			}
		}
	}

	// Ensure Content-Length is set when we have a body and no streaming encoding
	if (
		bodyBuffer !== undefined &&
		!headers["Content-Length"] &&
		!headers["Transfer-Encoding"]
	) {
		headers["Content-Length"] = String(
			typeof bodyBuffer === "string"
				? Buffer.byteLength(bodyBuffer)
				: bodyBuffer.length,
		);
	}

	return new Promise<Response>((resolve, reject) => {
		const req = httpModule.request(
			{
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (isHttps ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method,
				headers,
			},
			(res) => {
				// Build web-standard Headers
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (value) {
						if (Array.isArray(value)) {
							for (const v of value) {
								responseHeaders.append(key, v);
							}
						} else {
							responseHeaders.set(key, value);
						}
					}
				}

				// Create ReadableStream from Node.js Readable
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						res.on("data", (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk));
						});
						res.on("end", () => {
							controller.close();
						});
						res.on("error", (err) => {
							controller.error(err);
						});
					},
					cancel() {
						res.destroy();
					},
				});

				resolve(
					new Response(stream, {
						status: res.statusCode ?? 200,
						statusText: res.statusMessage ?? "",
						headers: responseHeaders,
					}),
				);
			},
		);

		req.on("error", (err) => {
			reject(err);
		});

		// Handle abort signal
		if (init?.signal) {
			const onAbort = () => {
				req.destroy(new DOMException("Aborted", "AbortError"));
			};
			if (init.signal.aborted) {
				onAbort();
			} else {
				init.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Write body and end
		if (bodyBuffer !== undefined) {
			req.write(bodyBuffer);
		}
		req.end();
	});
}
