import { requestUrl, TFile } from "obsidian";
import type NoteAssistantPlugin from "../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import { getMimeType } from "../../utils/mime-helper";
import { requireFile } from "./obsidian/_shared";
import { isFailure } from "./obsidian/_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Registration entry
// ─────────────────────────────────────────────────────────────────────────────

export function createWebUploadTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinWebUploadEnabled) return [];
    return [webUploadFile(plugin)];
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME type inference (delegated to _shared.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the MIME type for a vault file.
 *
 * Priority:
 * 1. If `mimeTypeOverride` is provided, use it directly.
 * 2. Otherwise delegate to `getMimeType()` which covers images, videos, audio,
 *    documents, text, and archives.
 * 3. Falls back to `application/octet-stream` for unknown extensions.
 */
function resolveMimeType(file: TFile, mimeTypeOverride?: string): string {
    if (mimeTypeOverride) return mimeTypeOverride;
    return getMimeType(file.extension);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: web_upload_file
// ─────────────────────────────────────────────────────────────────────────────

function webUploadFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "web_upload_file",
                description:
                    "Upload a vault file to an external URL via HTTP PUT or POST. " +
                    "Reads the file from the vault, auto-detects the MIME type from the file extension, " +
                    "and sends it as the request body. Useful for MCP tools or external services " +
                    "that accept file uploads via raw HTTP. " +
                    "The URL must accept the file bytes as the request body. " +
                    "IMPORTANT: only use this when the user explicitly asks you to upload a " +
                    "specific file to a specific service. Do NOT upload files without the user's " +
                    "explicit request.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path of the file to upload (e.g. 'Notes/report.pdf').",
                        },
                        url: {
                            type: "string",
                            description: "The target URL to upload the file to. The file bytes are sent as the request body.",
                        },
                        method: {
                            type: "string",
                            description: "HTTP method to use for the upload. Defaults to PUT. Use POST for services that require it.",
                            enum: ["PUT", "POST"],
                        },
                        mime_type: {
                            type: "string",
                            description:
                                "Optional MIME type override. If not provided, the MIME type is auto-detected from the file extension. " +
                                "Use this when the target service expects a specific Content-Type that differs from the auto-detected value " +
                                "(e.g. sending a .md file as 'text/plain' instead of 'text/markdown').",
                        },
                        headers: {
                            type: "object",
                            description:
                                "Optional additional HTTP headers as key-value pairs (e.g. {\"Authorization\": \"Bearer token\"}). " +
                                "The Content-Type header is set automatically based on the MIME type. " +
                                "Content-Length is set automatically from the file size.",
                            additionalProperties: { type: "string" },
                        },
                    },
                    required: ["path", "url"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream: ChatStream, args, signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const url = args["url"] as string;
            const method = (args["method"] as string | undefined) ?? "PUT";
            const mimeTypeOverride = args["mime_type"] as string | undefined;
            const headers = (args["headers"] as Record<string, string> | undefined) ?? {};

            // ── Validate method ──────────────────────────────────────────
            const methodUpper = method.toUpperCase();
            if (methodUpper !== "PUT" && methodUpper !== "POST") {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Unsupported HTTP method: ${method}. Only PUT and POST are supported.`,
                };
            }

            // ── Resolve file ──────────────────────────────────────────────
            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            // ── Read file as binary ────────────────────────────────────────
            let buffer: ArrayBuffer;
            try {
                buffer = await plugin.app.vault.readBinary(file);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    success: false,
                    type: "text",
                    content: `Failed to read file ${path}: ${msg}`,
                };
            }

            // ── Resolve MIME type ─────────────────────────────────────────
            const mimeType = resolveMimeType(file, mimeTypeOverride);

            // ── Abort check before request ────────────────────────────────
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // ── Upload using Obsidian's requestUrl ────────────────────────
            try {
                const response = await requestUrl({
                    url,
                    method: methodUpper,
                    contentType: mimeType,
                    body: buffer,
                    headers,
                    throw: false,
                });

                const responseText = response.text;
                const truncated = responseText.length > 2000
                    ? responseText.substring(0, 2000) + `\n\n... (truncated, full response ${responseText.length} chars)`
                    : responseText;

                if (response.status >= 200 && response.status < 300) {
                    return {
                        success: true,
                        type: "text",
                        content:
                            `Uploaded ${path} (${buffer.byteLength} bytes, ${mimeType}) to ${url}\n` +
                            `HTTP ${response.status}: ${truncated}`,
                    };
                } else {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `Upload failed: HTTP ${response.status}\n` +
                            `File: ${path} (${buffer.byteLength} bytes, ${mimeType})\n` +
                            `URL: ${url}\n` +
                            `Response: ${truncated}`,
                    };
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    success: false,
                    type: "text",
                    content:
                        `Upload failed: ${msg}\n` +
                        `File: ${path} (${buffer.byteLength} bytes, ${mimeType})\n` +
                        `URL: ${url}`,
                };
            }
        },
    };
}
