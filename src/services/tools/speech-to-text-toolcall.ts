import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import type { SpeechToTextConfig } from "../../settings";
import { getActiveSpeechToTextConfig } from "../../settings";
import { normalizePath, TFile, arrayBufferToBase64, type App } from "obsidian";
import { transcribeWithQwenASR } from "../speech-to-text/qwen-asr";
import { getMimeType } from "../../utils/mime-helper";
import { recordIssue } from "../diagnostics/issue-tracer";
import { isAbortError } from "../../utils/abortable-request";

/**
 * Create the speech-to-text tool based on the active speech-to-text config.
 * Returns undefined if speech-to-text is not configured.
 */
export function createSpeechToTextTool(plugin: NoteAssistantPlugin): RegisteredTool | undefined {
    const sttConfig = getActiveSpeechToTextConfig(plugin.settings);
    if (!sttConfig) {
        return undefined;
    }

    switch (sttConfig.apiScheme) {
        case 'qwen-asr':
        default:
            return createQwenASRTool(plugin, sttConfig);
    }
}

/**
 * Create Qwen ASR speech-to-text tool.
 */
function createQwenASRTool(plugin: NoteAssistantPlugin, sttConfig: Pick<SpeechToTextConfig, 'apiKey' | 'model' | 'baseUrl'>): RegisteredTool {
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
                    "Returns the transcribed text content.",
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
                const { dataUri } = await readAudioFileAsDataUri(plugin.app, audioFilePath);

                const result = await transcribeWithQwenASR(plugin, sttConfig, {
                    audioDataUri: dataUri,
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
            } catch (err) {
                return handleSTTError(err);
            }
        },
    };
}

/**
 * Read an audio file from the vault and return it as a data URI.
 */
async function readAudioFileAsDataUri(
    app: App,
    rawPath: string,
): Promise<{ dataUri: string; mimeType: string }> {
    const normalizedPath = normalizePath(rawPath);
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || !(file instanceof TFile)) {
        throw new Error(`Audio file not found in vault: ${rawPath}`);
    }

    const ext = file.extension.toLowerCase();

    // Temp file-size gate: base64 inlining is only practical up to ~7.5 MB.
    // Larger recordings will be handled by an async upload task system (TBD)
    // that uploads the file first, then feeds a URL instead of a data URI.
    const MAX_INLINE_BYTES = 7_864_320; // 7.5 MB
    if (file.stat.size > MAX_INLINE_BYTES) {
        throw new Error(
            `Audio file is too large for transcription (${(file.stat.size / 1024 / 1024).toFixed(1)} MB > ${(MAX_INLINE_BYTES / 1024 / 1024).toFixed(1)} MB). ` +
            `Large recordings will be supported via an async upload task system in a future update.`,
        );
    }

    // Supported audio formats for ASR
    const supportedExtensions = ["mp3", "wav", "m4a", "ogg", "flac", "webm", "aac", "opus", "wma"];
    if (!supportedExtensions.includes(ext)) {
        throw new Error(
            `Unsupported audio format "${ext}". Supported formats: ${supportedExtensions.join(", ")}`,
        );
    }

    const mimeType = getMimeType(ext, "audio/mpeg");
    let arrayBuffer: ArrayBuffer;
    try {
        arrayBuffer = await app.vault.readBinary(file);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read audio file "${rawPath}": ${msg}`);
    }

    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUri = `data:${mimeType};base64,${base64}`;
    return { dataUri, mimeType };
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
