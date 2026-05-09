import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import type { ImageGenResult, ReferenceImage } from "../image-gen/types";
import { getActiveImageGenConfig, type ImageGenConfig } from "../../settings";
import { sha256 } from "../../utils/hash";
import { base64ToArrayBuffer, arrayBufferToBase64, normalizePath, TFile, type App } from "obsidian";
import { joinPath } from "../../utils/path-helper";
import { generateImageWithGemini } from "../image-gen/gemini-image";
import { generateImageWithQwen } from "../image-gen/qwen-image";
import { generateImageWithOpenAI } from "../image-gen/openai-image";

/**
 * Create the image generation tool based on the active image gen config.
 * Returns undefined if image generation is not configured.
 */
export function createImageTool(plugin: NoteAssistantPlugin): RegisteredTool | undefined {
    const imageConfig = getActiveImageGenConfig(plugin.settings);
    if (!imageConfig) {
        return undefined;
    }

	switch (imageConfig.apiScheme) {
        case 'qwen':
            return createQwenImageTool(plugin, imageConfig);
        case 'openai':
            return createOpenAIImageTool(plugin, imageConfig);
        case 'gemini':
        default:
            return createGeminiImageTool(plugin, imageConfig);
    }
}

/** Shared schema fragment for the reference_image_paths parameter. */
const REFERENCE_IMAGE_PATHS_SCHEMA = {
    type: "array" as const,
    description:
        "Vault file paths of referenced images to use as visual references for image-to-image generation. " +
        "Only include paths of image files (png, jpg, jpeg, webp, gif). " +
        "If the user referenced image files in their message, include those paths here. " +
        "Leave as empty array or omit if no images are referenced (pure text-to-image). " +
        "Note: not all models support image-to-image; unsupported models will return an error.",
    items: { type: "string" as const },
};

/**
 * Read reference images from the vault.
 * Hard-fails (throws) on any read error, missing file, or unsupported extension.
 */
async function readReferenceImages(app: App, paths: string[]): Promise<ReferenceImage[]> {
    const result: ReferenceImage[] = [];
    for (const rawPath of paths) {
        const normalizedPath = normalizePath(rawPath);
        const file = app.vault.getAbstractFileByPath(normalizedPath);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`Referenced image not found in vault: ${rawPath}`);
        }
        const ext = file.extension.toLowerCase();
        const mimeType = extToMimeType(ext);
        if (!mimeType) {
            throw new Error(`Referenced file is not a supported image (${ext}): ${rawPath}`);
        }
        let arrayBuffer: ArrayBuffer;
        try {
            arrayBuffer = await app.vault.readBinary(file);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to read referenced image "${rawPath}": ${msg}`);
        }
        const base64 = arrayBufferToBase64(arrayBuffer);
        result.push({
            path: rawPath,
            arrayBuffer,
            base64,
            mimeType,
            fileName: file.name,
        });
    }
    return result;
}

function extToMimeType(ext: string): string | null {
    const map: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
    };
    return map[ext] || null;
}

/**
 * Create Gemini image generation tool.
 * Gemini supports reference images for image-to-image generation.
 */
function createGeminiImageTool(plugin: NoteAssistantPlugin, imageConfig: Pick<ImageGenConfig, 'apiKey' | 'model'>): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "generate_image",
                description:
                    "Generate an image based on a text description using AI. " +
                    "The generated image will be saved to the vault and a markdown image link will be returned. " +
                    "Use this when the user asks to create, draw, generate, design, make, or produce " +
                    "an image, illustration, picture, or artwork.",
                parameters: {
                    type: "object",
                    properties: {
                        prompt: {
                            type: "string",
                            description:
                                "A detailed text description of the image to generate. " +
                                "Be as specific as possible about the subject, style, composition, colors, and mood.",
                        },
                        aspect_ratio: {
                            type: "string",
                            description:
                                "The aspect ratio of the generated image. " +
                                "Supported values: '1:1' (square), '16:9' (landscape), '9:16' (portrait), '4:3', '3:4'.",
                            enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
                        },
                        reference_image_paths: REFERENCE_IMAGE_PATHS_SCHEMA,
                    },
                    required: ["prompt"],
                },
            },
        },
        capabilities: ["network", "create_file", "read_file", "multimodal_generate"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const prompt = args["prompt"] as string;
            const aspectRatio = (args["aspect_ratio"] as string) || "1:1";
            const refImagePaths = (args["reference_image_paths"] as string[] | undefined) || [];

            try {
                const refImages = refImagePaths.length > 0
                    ? await readReferenceImages(plugin.app, refImagePaths)
                    : [];
                const result = await generateImageWithGemini(plugin, imageConfig, {
                    prompt,
                    aspectRatio,
                    refImages,
                    signal,
                });
                return handleImageGenResult(plugin, result);
            } catch (err) {
                return handleImageGenError(err);
            }
        },
    };
}

/**
 * Create Qwen image generation tool.
 * Qwen supports negative prompt and size in pixels.
 */
function createQwenImageTool(plugin: NoteAssistantPlugin, imageConfig: Pick<ImageGenConfig, 'apiKey' | 'model'>): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "generate_image",
                description:
                    "Generate an image based on a text description using AI. " +
                    "The generated image will be saved to the vault and a markdown image link will be returned. " +
                    "Use this when the user asks to create, draw, generate, design, make, or produce " +
                    "an image, illustration, picture, or artwork.",
                parameters: {
                    type: "object",
                    properties: {
                        prompt: {
                            type: "string",
                            description:
                                "A detailed text description of the image to generate. " +
                                "Be as specific as possible about the subject, style, composition, colors, and mood.",
                        },
                        size: {
                            type: "string",
                            description:
                                "The size of the generated image in pixels (width*height). " +
                                "Supported values: '1024*1024' (square), '1920*1080' (landscape 16:9), " +
                                "'1080*1920' (portrait 9:16), '1440*1080' (4:3), '1080*1440' (3:4).",
                            enum: ["1024*1024", "1920*1080", "1080*1920", "1440*1080", "1080*1440"],
                        },
                        negative_prompt: {
                            type: "string",
                            description:
                                "A text description of what to avoid in the generated image. " +
                                "Describe elements, styles, or qualities that should NOT appear in the image. " +
                                "Leave empty or omit if not needed.",
                        },
                        reference_image_paths: REFERENCE_IMAGE_PATHS_SCHEMA,
                    },
                    required: ["prompt"],
                },
            },
        },
        capabilities: ["network", "create_file", "read_file", "multimodal_generate"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const prompt = args["prompt"] as string;
            const size = (args["size"] as string) || "1024*1024";
            const negativePrompt = (args["negative_prompt"] as string) || "";
            const refImagePaths = (args["reference_image_paths"] as string[] | undefined) || [];

            try {
                const refImages = refImagePaths.length > 0
                    ? await readReferenceImages(plugin.app, refImagePaths)
                    : [];
                const result = await generateImageWithQwen(plugin, imageConfig, {
                    prompt,
                    size,
                    negativePrompt,
                    refImages,
                    signal,
                });
                return handleImageGenResult(plugin, result);
            } catch (err) {
                return handleImageGenError(err);
            }
        },
    };
}

/**
 * Create OpenAI-compatible image generation tool.
 * Works with OpenAI (DALL-E) and other OpenAI-compatible APIs.
 */
function createOpenAIImageTool(plugin: NoteAssistantPlugin, imageConfig: Pick<ImageGenConfig, 'apiKey' | 'model' | 'baseUrl'>): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "generate_image",
                description:
                    "Generate an image based on a text description using AI. " +
                    "The generated image will be saved to the vault and a markdown image link will be returned. " +
                    "Use this when the user asks to create, draw, generate, design, make, or produce " +
                    "an image, illustration, picture, or artwork.",
                parameters: {
                    type: "object",
                    properties: {
                        prompt: {
                            type: "string",
                            description:
                                "A detailed text description of the image to generate. " +
                                "Be as specific as possible about the subject, style, composition, colors, and mood.",
                        },
                        size: {
                            type: "string",
                            description:
                                "The size of the generated image. " +
                                "Supported values: '1024x1024' (square), '1792x1024' (landscape), '1024x1792' (portrait).",
                            enum: ["1024x1024", "1792x1024", "1024x1792"],
                        },
                        quality: {
                            type: "string",
                            description:
                                "The quality of the generated image. " +
                                "Supported values: 'standard', 'hd'. Only available for DALL-E 3.",
                            enum: ["standard", "hd"],
                        },
                        style: {
                            type: "string",
                            description:
                                "The style of the generated image. " +
                                "Supported values: 'vivid' (hyper-real), 'natural' (more natural). Only available for DALL-E 3.",
                            enum: ["vivid", "natural"],
                        },
                        reference_image_paths: REFERENCE_IMAGE_PATHS_SCHEMA,
                    },
                    required: ["prompt"],
                },
            },
        },
        capabilities: ["network", "create_file", "read_file", "multimodal_generate"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const prompt = args["prompt"] as string;
            const size = (args["size"] as string) || "1024x1024";
            const quality = args["quality"] as string | undefined;
            const style = args["style"] as string | undefined;
            const refImagePaths = (args["reference_image_paths"] as string[] | undefined) || [];

            try {
                const refImages = refImagePaths.length > 0
                    ? await readReferenceImages(plugin.app, refImagePaths)
                    : [];
                const result = await generateImageWithOpenAI(plugin, imageConfig, {
                    prompt,
                    size,
                    quality,
                    style,
                    refImages,
                    signal,
                });
                return handleImageGenResult(plugin, result);
            } catch (err) {
                return handleImageGenError(err);
            }
        },
    };
}

/**
 * Handle image generation result and save to vault.
 */
async function handleImageGenResult(plugin: NoteAssistantPlugin, result: ImageGenResult): Promise<ToolCallResult> {
    if (!result.success) {
        return {
            success: false,
            type: "text",
            content: result.error || "Image generation failed.",
        };
    }

    // If the model returned text but no image
    if (!result.imageData) {
        return {
            success: true,
            type: "text",
            content: result.text || "The model did not generate any image.",
        };
    }

    // Save the image to the vault
    const ext = mimeTypeToExt(result.mimeType || "image/png");
    const filename = await buildUniqueFilename(result.imageData, ext);
    const savedPath = await saveImageToVault(plugin, filename, result.imageData);

    if (!savedPath) {
        return {
            success: false,
            type: "text",
            content: "Failed to save the generated image to the vault.",
        };
    }

    // Build the response content
    let content = "";
    if (result.text) {
        content = result.text + "\n\n";
    }
    content += `![generated image](${savedPath})`;

    return { success: true, type: "text", content };
}

/**
 * Handle image generation error.
 */
function handleImageGenError(err: unknown): ToolCallResult {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate_image] Error:", err);
    return {
        success: false,
        type: "text",
        content: `Image generation failed: ${msg}`,
    };
}

function mimeTypeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    };
    return map[mimeType] || "png";
}

async function buildUniqueFilename(base64Data: string, ext: string): Promise<string> {
    const hash = await sha256(base64Data);
    // Use first 16 chars of hash for a shorter but still unique filename
    return `GEN_${hash.slice(0, 16)}_SHA256.${ext}`;
}

async function saveImageToVault(
    plugin: NoteAssistantPlugin,
    filename: string,
    base64Data: string,
): Promise<string | null> {
    const vault = plugin.app.vault;
    const imageDownloadDir = plugin.settings.imageDownloadDir || 'Attachments';

    const vaultRoot = vault.getRoot().path;
    const saveDir = joinPath(vaultRoot, imageDownloadDir);

    // Ensure the directory exists
    if (!vault.getAbstractFileByPath(saveDir)) {
        await vault.createFolder(saveDir);
    }

    // Convert base64 to ArrayBuffer using Obsidian API
    const arrayBuffer = base64ToArrayBuffer(base64Data);

    const filepath = joinPath(saveDir, filename);

    try {
        // If file already exists, skip (same image)
        if (vault.getAbstractFileByPath(filepath)) {
            return filepath;
        }
        await vault.createBinary(filepath, arrayBuffer);
        return filepath;
    } catch (err) {
        console.error(`[generate_image] Failed to save image to ${filepath}:`, err);
        return null;
    }
}
