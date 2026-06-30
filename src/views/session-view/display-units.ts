import type { ChatMessage } from '../../services/chat-stream';

/** One bubble worth of history — a main message or an inline sub-agent reply. */
export interface DisplayUnit {
    msg: ChatMessage;
}

export interface BuildDisplayUnitsOptions {
    getSubAgentMessages?: (toolCallId: string) => ReadonlyArray<ChatMessage>;
}

/**
 * Flatten the runtime message list into the ordered sequence of bubbles
 * {@link SessionView} would render during replay. Keeps delegate_task →
 * sub-agent expansion in one place so replay, windowing, and search
 * share the same ordering contract.
 */
export function buildDisplayUnits(
    messages: ReadonlyArray<ChatMessage>,
    opts: BuildDisplayUnitsOptions = {},
): DisplayUnit[] {
    const units: DisplayUnit[] = [];
    const getSub = opts.getSubAgentMessages;

    for (const msg of messages) {
        units.push({ msg });

        if (
            msg.role === 'tool_call'
            && msg.toolCallMeta?.toolName === 'delegate_task'
            && getSub
        ) {
            const tcId = msg.toolCallMeta.toolCallId;
            const children = getSub(tcId);
            const delegateAgent = msg.toolCallMeta.toolArgs?.['agent'] as string | undefined;
            for (const child of children) {
                // Skip sub-agent assistant messages whose content is
                // whitespace-only (e.g. "\n\n" that some LLMs emit as
                // leading noise before tool calls or prose).  The
                // streaming pipeline already prevents these from
                // entering new sessions; this is a defence-in-depth
                // guard for historical sessions that already contain
                // such artefacts.
                if (
                    child.role === 'assistant'
                    && child.content.trim() === ''
                    && !(child.thinkingContent?.trim())
                ) {
                    continue;
                }
                const tagged = child.subAgent
                    ? child
                    : delegateAgent
                        ? {
                            ...child,
                            subAgent: {
                                agentName: delegateAgent,
                                parentToolCallId: tcId,
                            },
                        }
                        : child;
                units.push({ msg: tagged });
            }
        }
    }

    return units;
}

export function findDisplayUnitIndex(units: ReadonlyArray<DisplayUnit>, messageId: string): number {
    return units.findIndex(u => u.msg.id === messageId);
}
