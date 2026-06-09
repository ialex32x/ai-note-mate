/**
 * Result from speech-to-text transcription.
 */
export interface SpeechToTextResult {
    success: boolean;
    /** Transcribed text content */
    text?: string;
    /** Error message if success is false */
    error?: string;
}
