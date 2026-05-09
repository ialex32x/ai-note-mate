/**
 * Result from image generation.
 */
export interface ImageGenResult {
    success: boolean;
    /** Base64 encoded image data */
    imageData?: string;
    /** MIME type of the image (e.g., "image/png") */
    mimeType?: string;
    /** Optional text content from the model */
    text?: string;
    /** Error message if success is false */
    error?: string;
}

/**
 * A reference image loaded from the vault, shared by all image providers
 * for image-to-image generation.
 */
export interface ReferenceImage {
    /** Original vault path as given by the LLM. */
    path: string;
    /** Raw bytes read from the vault. */
    arrayBuffer: ArrayBuffer;
    /** Base64 encoded data (no data-uri prefix). */
    base64: string;
    /** MIME type inferred from the file extension. */
    mimeType: string;
    /** File name with extension, useful for constructing multipart uploads. */
    fileName: string;
}
