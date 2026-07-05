/**
 * Image compression using Canvas API.
 *
 * Re-encodes a base64-encoded image at a given quality level (10–100).
 * Uses `OffscreenCanvas` when available, falling back to `HTMLCanvasElement`
 * for platforms without OffscreenCanvas support (e.g. iOS < 16.4).
 *
 * No third-party dependencies — relies on browser-native Canvas API.
 */

/**
 * Compress a base64-encoded image to JPEG with the specified quality.
 *
 * @param base64 - The raw base64-encoded image data (without data-URI prefix).
 * @param mimeType - The original MIME type (e.g. "image/png").
 * @param quality - Quality percentage 10–100. 100 returns the original unchanged.
 * @returns A promise resolving to `{ base64, mimeType }` with the compressed image.
 *          When quality is 100, returns a shallow copy of the input without processing.
 */
export async function compressImage(
    base64: string,
    mimeType: string,
    quality: number,
): Promise<{ base64: string; mimeType: string }> {
    // No compression needed at 100%
    if (quality >= 100) {
        return { base64, mimeType };
    }

    // Clamp quality to valid range
    const clampedQuality = Math.max(10, Math.min(100, quality)) / 100;

    // Decode the image
    const img = await decodeBase64Image(base64, mimeType);

    // Use OffscreenCanvas when available (fast, no DOM), fall back to HTMLCanvasElement
    const useOffscreen = typeof OffscreenCanvas !== 'undefined';

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

    if (useOffscreen) {
        canvas = new OffscreenCanvas(img.width, img.height);
        ctx = canvas.getContext('2d');
    } else {
        canvas = createEl('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx = canvas.getContext('2d');
    }

    if (!ctx) {
        // Canvas context creation failed — return original
        return { base64, mimeType };
    }

    ctx.drawImage(img, 0, 0);

    // Always compress to JPEG for quality control (PNG is lossless, no quality param)
    const outType = 'image/jpeg';

    if (useOffscreen && canvas instanceof OffscreenCanvas) {
        const blob = await canvas.convertToBlob({ type: outType, quality: clampedQuality });
        const compressedBase64 = await blobToBase64(blob);
        return { base64: compressedBase64, mimeType: outType };
    }

    if (canvas instanceof HTMLCanvasElement) {
        const dataUrl = canvas.toDataURL(outType, clampedQuality);
        // Strip the data-URI prefix (e.g. "data:image/jpeg;base64,")
        const commaIdx = dataUrl.indexOf(',');
        const compressedBase64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
        return { base64: compressedBase64, mimeType: outType };
    }

    // Fallback: return original
    return { base64, mimeType };
}

/**
 * Decode a base64 image string into an HTMLImageElement.
 */
function decodeBase64Image(base64: string, mimeType: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode image for compression'));
        img.src = `data:${mimeType};base64,${base64}`;
    });
}

/**
 * Convert a Blob to a base64 string (without data-URI prefix).
 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string | null;
            if (result) {
                const commaIdx = result.indexOf(',');
                resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
            } else {
                reject(new Error('Failed to read compressed image blob'));
            }
        };
        reader.onerror = () => reject(new Error('Failed to read compressed image blob'));
        reader.readAsDataURL(blob);
    });
}
