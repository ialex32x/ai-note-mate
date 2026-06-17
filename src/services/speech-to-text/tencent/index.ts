/**
 * Tencent Cloud ASR speech-to-text — unified entry point.
 *
 * Re-exports:
 *   - `transcribeWithTencentASR` — full orchestrator (base64 or COS upload + polling).
 *   - `TencentASRFullParams` / `TencentASRFullResult` — types for the flow.
 */

export { transcribeWithTencentASR } from "./stt-index";
export type { TencentASRFullParams, TencentASRFullResult } from "./stt-index";
export { createRecTask, describeTaskStatus, toSttResult } from "./asr-client";
export type { TencentASRParams, CreateRecTaskRequest, DescribeTaskStatusRequest, TaskStatusResult, TaskStatusCode } from "./asr-client";
