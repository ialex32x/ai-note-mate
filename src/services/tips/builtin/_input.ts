import type { TipContext } from '../types';

/** True when the session chat input has no user-authored text (trimmed). */
export function isPromptInputEmpty(ctx: TipContext): boolean {
    return ctx.sessionView.isPromptInputEmpty();
}
