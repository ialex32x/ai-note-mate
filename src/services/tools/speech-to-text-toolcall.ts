import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import type { SpeechToTextConfig } from "../../settings";
import type { ArtifactStore } from "../artifact-store";
import { getActiveSpeechToTextConfig, getSttBaseUrl, isCosConfigured } from "../../settings";
import { normalizePath, TFile, arrayBufferToBase64, type App } from "obsidian";
import { transcribeWithQwenASR, transcribeLargeFileWithAsyncASR } from "../speech-to-text/qwen";
import { transcribeWithTencentASR } from "../speech-to-text/tencent";
import { getMimeType } from "../../utils/mime-helper";
import { resolveSecret } from "../../utils/secret-helper";
import { recordIssue } from "../diagnostics/issue-tracer";
import { isAbortError } from "../../utils/abortable-request";

/**
 * Create the speech-to-text tool based on the active speech-to-text config.
 * Returns undefined if speech-to-text is not configured.
 *
 * @param getArtifactStore Optional getter for the per-session artifact store.
 *   Required for large-file async transcription. If omitted (e.g. tests,
 *   single-agent mode without a runtime), large files fall back to the
 *   existing "file too large" error.
 */
export function createSpeechToTextTool(
    plugin: NoteAssistantPlugin,
    getArtifactStore?: () => ArtifactStore | null,
): RegisteredTool | undefined {
    const sttConfig = getActiveSpeechToTextConfig(plugin.settings);
    if (!sttConfig) {
        return undefined;
    }

    switch (sttConfig.apiScheme) {
        case 'TencentCloud':
            return createTencentCloudASRTool(plugin, sttConfig, getArtifactStore);
        case 'DashScope':
        default:
            return createQwenASRTool(plugin, sttConfig, getArtifactStore);
    }
}

/**
 * Create Qwen ASR speech-to-text tool.
 */
function createQwenASRTool(
    plugin: NoteAssistantPlugin,
    sttConfig: SpeechToTextConfig,
    getArtifactStore?: () => ArtifactStore | null,
): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "transcribe_audio",
                description:
                    "Transcribe audio from a file in the vault to text using AI speech-to-text. " +
                    "Use this when the user asks to transcribe, convert speech to text, or get the text content " +
                    "from an audio file (mp3, wav, m4a, ogg, flac, webm). " +
                    "Returns the transcribed text content. " +
                    "For large files, the transcription runs asynchronously and the result is saved " +
                    "in the artifact store — use recall_artifact to retrieve it if the tool reports " +
                    "the task is still running.",
                parameters: {
                    type: "object",
                    properties: {
                        audio_file_path: {
                            type: "string",
                            description:
                                "The vault file path of the audio file to transcribe. " +
                                "Supported formats: mp3, wav, m4a, ogg, flac, webm. " +
                                "The file must exist in the vault.",
                        },
                        language: {
                            type: "string",
                            description:
                                "Optional language hint for transcription (e.g. 'zh' for Chinese, 'en' for English). " +
                                "Omit for automatic language detection.",
                        },
                        enable_itn: {
                            type: "boolean",
                            description:
                                "Enable Inverse Text Normalization (ITN) to convert spoken forms into written forms " +
                                "(e.g. 'one two three' → '123'). Default is false.",
                        },
                    },
                    required: ["audio_file_path"],
                },
            },
        },
        capabilities: ["network", "read_file"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const audioFilePath = args["audio_file_path"] as string;
            const language = args["language"] as string | undefined;
            const enableItn = (args["enable_itn"] as boolean) || false;

            try {
                // Read the audio file from the vault
                const readResult = await readAudioFileForTranscription(plugin.app, audioFilePath);

                // ── Small file: inline transcription via compatible-mode API ──
                if (readResult.type === "dataUri") {
                    const dashscopeBaseUrl = getSttBaseUrl(sttConfig.region, sttConfig.workspaceId);
                    const result = await transcribeWithQwenASR(plugin, {
                        apiKey: sttConfig.apiKey,
                        model: sttConfig.shortModel,
                        baseUrl: `${dashscopeBaseUrl}/compatible-mode/v1`,
                    }, {
                        audioDataUri: readResult.dataUri,
                        stream: false,
                        enableItn,
                        language,
                        signal,
                    });

                    if (!result.success) {
                        return {
                            success: false,
                            type: "text",
                            content: result.error || "Speech-to-text transcription failed.",
                        };
                    }

                    const text = result.text || "";
                    return {
                        success: true,
                        type: "text",
                        content: text,
                    };
                }

                // ── Large file: async transcription via OSS upload + task polling ──
                const artifactStore = getArtifactStore?.();
                if (!artifactStore) {
                    return {
                        success: false,
                        type: "text",
                        content: `Audio file is too large for inline transcription (${(readResult.fileData.byteLength / 1024 / 1024).toFixed(1)} MB). ` +
                            `Async transcription requires an artifact store, which is not available in this session mode.`,
                    };
                }

                const apiKey = resolveSecret(plugin.app, sttConfig.apiKey);
                if (!apiKey) {
                    return {
                        success: false,
                        type: "text",
                        content: "DashScope API key is not configured.",
                    };
                }

                const dashscopeRootUrl = getSttBaseUrl(sttConfig.region, sttConfig.workspaceId);

                const asyncResult = await transcribeLargeFileWithAsyncASR({
                    apiKey,
                    dashscopeRootUrl,
                    model: sttConfig.longModel,
                    fileName: readResult.fileName,
                    fileData: readResult.fileData,
                    language,
                    signal,
                    artifactStore,
                    vaultPath: audioFilePath,
                });

                if (!asyncResult.success) {
                    return {
                        success: false,
                        type: "text",
                        content: asyncResult.error || "Speech-to-text transcription failed.",
                    };
                }

                return {
                    success: true,
                    type: "text",
                    content: asyncResult.text || "",
                };
            } catch (err) {
                return handleSTTError(err);
}
    },
    };
}

/**
 * Create Tencent Cloud ASR speech-to-text tool.
 */
function createTencentCloudASRTool(
    plugin: NoteAssistantPlugin,
    sttConfig: SpeechToTextConfig,
    getArtifactStore?: () => ArtifactStore | null,
): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "transcribe_audio",
                description:
                    "Transcribe audio from a file in the vault to text using Tencent Cloud speech-to-text. " +
                    "Use this when the user asks to transcribe, convert speech to text, or get the text content " +
                    "from an audio file (mp3, wav, m4a, ogg, flac, webm). " +
                    "Returns the transcribed text content. " +
                    "For large files, the transcription runs asynchronously and the result is saved " +
                    "in the artifact store — use recall_artifact to retrieve it if the tool reports " +
                    "the task is still running.",
                parameters: {
                    type: "object",
                    properties: {
                        audio_file_path: {
                            type: "string",
                            description:
                                "The vault file path of the audio file to transcribe. " +
                                "Supported formats: mp3, wav, m4a, ogg, flac, webm. " +
                                "The file must exist in the vault.",
                        },
                        language: {
                            type: "string",
                            description:
                                "Optional language hint for transcription (e.g. 'zh' for Chinese, 'en' for English). " +
                                "Omit for automatic language detection.",
                        },
                    },
                    required: ["audio_file_path"],
                },
            },
        },
        capabilities: ["network", "read_file"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const audioFilePath = args["audio_file_path"] as string;
            const language = args["language"] as string | undefined;

            try {
                // Read the audio file from the vault
                const readResult = await readAudioFileForTranscription(plugin.app, audioFilePath);

                // Tencent Cloud ASR always uses the async path (CreateRecTask + polling).
                // Files ≤ 5 MB: base64 inline via SourceType=1.
                // Files > 5 MB: COS upload → SourceType=0.
                const artifactStore = getArtifactStore?.();
                if (!artifactStore) {
                    return {
                        success: false,
                        type: "text",
                        content: `Transcription requires an artifact store, which is not available in this session mode.`,
                    };
                }

                if (readResult.type === "binary" && !isCosConfigured(sttConfig)) {
                    return {
                        success: false,
                        type: "text",
                        content: `Audio file is too large (${(readResult.fileData.byteLength / 1024 / 1024).toFixed(1)} MB). ` +
                            `Tencent Cloud requires COS bucket (format: name-appid) and region for files > 5 MB. ` +
                            `Please configure both in Settings → Speech-to-Text.`,
                    };
                }

                const resolvedSecretId = resolveSecret(plugin.app, sttConfig.secretId).trim();
                const resolvedSecretKey = resolveSecret(plugin.app, sttConfig.secretKey).trim();

                if (!resolvedSecretId || !resolvedSecretKey) {
                    return {
                        success: false,
                        type: "text",
                        content: "Tencent Cloud SecretId or SecretKey is not configured.",
                    };
                }

                // Debug: log key lengths (not values) to diagnose signing issues
                console.debug("[TencentCloudSTT] resolved SecretId length:", resolvedSecretId.length,
                    "SecretKey length:", resolvedSecretKey.length);

                const asyncResult = await transcribeWithTencentASR({
                    secretId: resolvedSecretId,
                    secretKey: resolvedSecretKey,
                    engineModelType: sttConfig.engineModelType || '16k_zh',
                    region: sttConfig.region,
                    fileName: readResult.type === "binary" ? readResult.fileName : audioFilePath.split("/").pop() || "audio.wav",
                    fileData: readResult.type === "binary" ? readResult.fileData : dataUriToArrayBuffer(readResult.dataUri),
                    cosBucket: sttConfig.cosBucket || undefined,
                    cosRegion: sttConfig.cosRegion || undefined,
                    language,
                    signal,
                    artifactStore,
                    vaultPath: audioFilePath,
                });

                if (!asyncResult.success) {
                    return {
                        success: false,
                        type: "text",
                        content: asyncResult.error || "Speech-to-text transcription failed.",
                    };
                }

                return {
                    success: true,
                    type: "text",
                    content: asyncResult.text || "",
                };
            } catch (err) {
                return handleSTTError(err);
            }
        },
    };
}

/** Convert data URI to ArrayBuffer (for extracting binary from data URIs). */
function dataUriToArrayBuffer(dataUri: string): ArrayBuffer {
    const base64 = dataUri.split(",")[1];
    if (!base64) throw new Error("Invalid data URI: missing base64 data");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Result of reading an audio file for transcription.
 */
type AudioFileReadResult =
    | { type: "dataUri"; dataUri: string; mimeType: string }
    | { type: "binary"; fileName: string; fileData: ArrayBuffer };

/**
 * Max file size for inline (base64 data URI) transcription.
 * Files larger than this are routed to the async OSS-upload path.
 */
const MAX_INLINE_BYTES = 7_864_320; // 7.5 MB

/**
 * Read an audio file from the vault.
 *
 * - Files ≤ 7.5 MB: return as a base64 data URI (for inline compatible-mode API).
 * - Files > 7.5 MB: return raw binary (for async OSS-upload API).
 */
async function readAudioFileForTranscription(
    app: App,
    rawPath: string,
): Promise<AudioFileReadResult> {
    const normalizedPath = normalizePath(rawPath);
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || !(file instanceof TFile)) {
        throw new Error(`Audio file not found in vault: ${rawPath}`);
    }

    const ext = file.extension.toLowerCase();

    // Supported audio formats for ASR
    const supportedExtensions = ["mp3", "wav", "m4a", "ogg", "flac", "webm", "aac", "opus", "wma"];
    if (!supportedExtensions.includes(ext)) {
        throw new Error(
            `Unsupported audio format "${ext}". Supported formats: ${supportedExtensions.join(", ")}`,
        );
    }

    let arrayBuffer: ArrayBuffer;
    try {
        arrayBuffer = await app.vault.readBinary(file);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read audio file "${rawPath}": ${msg}`);
    }

    // Large file: return raw binary for async OSS upload
    if (file.stat.size > MAX_INLINE_BYTES) {
        return {
            type: "binary",
            fileName: file.name,
            fileData: arrayBuffer,
        };
    }

    // Small file: encode as data URI for inline API
    const mimeType = getMimeType(ext, "audio/mpeg");
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUri = `data:${mimeType};base64,${base64}`;
    return { type: "dataUri", dataUri, mimeType };
}

/**
 * Handle speech-to-text error.
 */
function handleSTTError(err: unknown): ToolCallResult {
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[transcribe_audio] Error:", err);
    recordIssue({
        severity: 'error',
        source: 'speech-to-text-toolcall',
        code: 'stt-failed',
        message: `Speech-to-text transcription failed: ${msg}`,
        error: err,
    });
    return {
        success: false,
        type: "text",
        content: `Speech-to-text transcription failed: ${msg}`,
    };
}
