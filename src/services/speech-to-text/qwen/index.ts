/**
 * Qwen ASR (DashScope) speech-to-text — unified entry point.
 *
 * Re-exports everything the rest of the plugin needs:
 *   - `transcribeWithQwenASR` — small-file inline transcription (compatible-mode API).
 *   - `transcribeLargeFileWithAsyncASR` — large-file async transcription (OSS upload + polling).
 *   - `LargeFileASRParams` / `LargeFileASRResult` — types for the async flow.
 */

export { transcribeWithQwenASR } from "./qwen-asr";
export type { QwenASRParams } from "./qwen-asr";
export { transcribeLargeFileWithAsyncASR } from "./stt-index";
export type { LargeFileASRParams, LargeFileASRResult } from "./stt-index";
