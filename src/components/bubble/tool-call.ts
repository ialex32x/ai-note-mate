import { setIcon, setTooltip } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { prettifyIfJson } from '../../utils/json-format';
import { copyToClipboard } from '../../utils/clipboard';
import type { BubbleContext } from './bubble-context';

/**
 * Render the body of a tool-call bubble.
 *
 * Tool-call bubbles differ from regular assistant/user bubbles in two ways:
 *  1. They surface a compact single-line header (tool name + status icon)
 *     that expands on click to reveal arguments and result in a detail
 *     section — otherwise the chat history becomes unreadable once a few
 *     sizeable tool invocations land in it.
 *  2. They may display confirmation UI (approve / reject with an optional
 *     dropdown) while a tool call is awaiting user consent, and a status
 *     badge once a decision has been made.
 *
 * The module intentionally keeps all tool-call specific DOM logic together
 * so the main `BubbleRenderer` doesn't need to know about arguments,
 * results, or the inline copy buttons that sit next to each section label.
 *
 * @param ctx     Shared bubble context (floating layer, app, cleanup hooks).
 * @param contentEl            The bubble content element to populate.
 * @param msg                  The tool-call chat message.
 * @param wasToolDetailExpanded Whether the detail section should start
 *                             expanded (persisted UI state across re-renders).
 * @param pendingConfirmations Map of messageId → resolver for awaiting
 *                             user decisions on pending tool calls.
 */
export function renderToolCallContent(
    ctx: BubbleContext,
    contentEl: HTMLElement,
    msg: ChatMessage,
    wasToolDetailExpanded: boolean,
    pendingConfirmations: Map<string, (approved: boolean) => void>,
): void {
    const headerRow = contentEl.createEl('div', {
        cls: 'session-bubble__tool-header',
    });

    const arrow = wasToolDetailExpanded ? '▾' : '▸';
    const arrowSpan = headerRow.createEl('span', {
        cls: 'session-bubble__tool-arrow',
        text: arrow,
    });

    headerRow.createEl('span', {
        cls: 'session-bubble__tool-label',
        text: msg.streaming ? `${msg.content}  …` : msg.content,
    });

    if (msg.toolCallResult) {
        const statusIcon =
            msg.toolCallResult.status === 'error' ? '✕' :
            msg.toolCallResult.status === 'warning' ? '⚠' :
            '✓';
        const statusCls = `session-bubble__tool-status session-bubble__tool-status--${msg.toolCallResult.status}`;
        headerRow.createEl('span', { cls: statusCls, text: statusIcon });
    }

    if (msg.confirmationState === 'pending' && msg.streaming) {
        renderToolConfirmPending(ctx, contentEl, msg.id, pendingConfirmations);
    } else if (msg.confirmationState === 'allowed' || msg.confirmationState === 'rejected') {
        renderToolConfirmBadge(contentEl, msg.confirmationState);
    }

    if (msg.toolCallMeta || msg.toolCallResult) {
        if (wasToolDetailExpanded) {
            renderToolDetail(contentEl, msg, true, arrowSpan, headerRow);
        } else {
            renderToolDetailLazy(contentEl, msg, arrowSpan, headerRow);
        }
    }
}

function renderToolDetail(
    contentEl: HTMLElement,
    msg: ChatMessage,
    wasToolDetailExpanded: boolean,
    arrowSpan: HTMLElement,
    headerRow: HTMLElement,
): void {
    const detailBody = contentEl.createEl('div', {
        cls: wasToolDetailExpanded
            ? 'session-bubble__tool-detail-body session-bubble__tool-detail-body--expanded'
            : 'session-bubble__tool-detail-body',
    });

    populateToolDetailBody(detailBody, msg);

    let toolDetailExpanded = wasToolDetailExpanded;
    const toggleToolDetail = () => {
        toolDetailExpanded = !toolDetailExpanded;
        detailBody.toggleClass('session-bubble__tool-detail-body--expanded', toolDetailExpanded);
        arrowSpan.setText(toolDetailExpanded ? '▾' : '▸');
        headerRow.toggleClass('session-bubble__tool-header--expanded', toolDetailExpanded);
    };
    headerRow.addEventListener('click', toggleToolDetail);
    headerRow.addClass('session-bubble__tool-header--clickable');
    if (wasToolDetailExpanded) {
        headerRow.addClass('session-bubble__tool-header--expanded');
    }
}

/** Lazy detail: args/result DOM is created on first expand. */
function renderToolDetailLazy(
    contentEl: HTMLElement,
    msg: ChatMessage,
    arrowSpan: HTMLElement,
    headerRow: HTMLElement,
): void {
    let detailBody: HTMLElement | null = null;
    let toolDetailExpanded = false;

    const ensureDetail = (): HTMLElement => {
        if (!detailBody) {
            detailBody = contentEl.createEl('div', {
                cls: 'session-bubble__tool-detail-body',
            });
            populateToolDetailBody(detailBody, msg);
        }
        return detailBody;
    };

    const toggleToolDetail = () => {
        toolDetailExpanded = !toolDetailExpanded;
        const body = ensureDetail();
        body.toggleClass('session-bubble__tool-detail-body--expanded', toolDetailExpanded);
        arrowSpan.setText(toolDetailExpanded ? '▾' : '▸');
        headerRow.toggleClass('session-bubble__tool-header--expanded', toolDetailExpanded);
    };

    headerRow.addEventListener('click', toggleToolDetail);
    headerRow.addClass('session-bubble__tool-header--clickable');
}

function populateToolDetailBody(detailBody: HTMLElement, msg: ChatMessage): void {
    if (msg.toolCallMeta) {
        const argsWrapper = detailBody.createEl('div', { cls: 'session-bubble__tool-section' });
        argsWrapper.createEl('span', {
            cls: 'session-bubble__tool-section-label',
            text: 'Arguments',
        });
        const argsCode = argsWrapper.createEl('div', { cls: 'session-bubble__tool-code-wrap' });
        const argsPre = argsCode.createEl('pre', { cls: 'session-bubble__tool-code' });
        argsPre.setText(JSON.stringify(msg.toolCallMeta.toolArgs, null, 2));
        renderCopyOverlay(argsCode, t('view.copyToolArgs'), () => {
            const args = msg.toolCallMeta?.toolArgs;
            return args === undefined ? '' : JSON.stringify(args, null, 2);
        });
    }

    if (msg.toolCallResult) {
        const resultWrapper = detailBody.createEl('div', { cls: 'session-bubble__tool-section' });
        resultWrapper.createEl('span', {
            cls: 'session-bubble__tool-section-label',
            text: 'Result',
        });
        const resultCode = resultWrapper.createEl('div', { cls: 'session-bubble__tool-code-wrap' });
        const resultPre = resultCode.createEl('pre', { cls: 'session-bubble__tool-code' });
        const resultText = msg.toolCallResult.result;
        resultPre.setText(resultText.length > 2000 ? resultText.slice(0, 2000) + '\n... (truncated)' : resultText);
        renderCopyOverlay(resultCode, t('view.copyToolResult'), () => {
            const raw = msg.toolCallResult?.result ?? '';
            return prettifyIfJson(raw);
        });
    }
}

function renderCopyOverlay(
    parent: HTMLElement,
    copyAriaLabel: string,
    getCopyText: () => string,
): void {
    const copyBtn = parent.createEl('button', {
        cls: 'session-bubble__tool-section-copy-btn',
        attr: { type: 'button', 'aria-label': copyAriaLabel },
    });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, copyAriaLabel);
    const handleCopy = async (): Promise<void> => {
        const ok = await copyToClipboard(getCopyText(), { showNotice: false });
        if (!ok) return;
        setIcon(copyBtn, 'check');
        window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
    };
    copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        void handleCopy();
    });
}

function renderToolConfirmPending(
    ctx: BubbleContext,
    container: HTMLElement,
    messageId: string,
    pendingConfirmations: Map<string, (approved: boolean) => void>,
): void {
    const layer = ctx.getFloatingLayer();
    layer.querySelector(`[data-confirm-msg-id="${messageId}"]`)?.remove();

    const confirmRow = container.createEl('div', { cls: 'session-bubble__tool-confirm' });

    const allowBtn = confirmRow.createEl('button', {
        cls: 'session-bubble__tool-confirm-btn',
        text: t('view.toolConfirmApprove'),
        attr: { type: 'button' },
    });

    const arrowWrap = confirmRow.createEl('span', { cls: 'session-bubble__tool-confirm-arrow-wrap' });
    const arrowBtn = arrowWrap.createEl('button', {
        cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-arrow',
        attr: { type: 'button', 'aria-label': 'More options' },
    });
    setIcon(arrowBtn, 'chevron-down');

    const dropdown = layer.createEl('div', {
        cls: 'session-dropdown-menu session-dropdown-menu--anchored session-bubble__tool-confirm-dropdown',
        attr: { 'data-confirm-msg-id': messageId },
    });
    dropdown.hide();

    const rejectItem = dropdown.createEl('div', {
        cls: 'session-dropdown-item session-bubble__tool-confirm-dropdown-item',
        text: t('view.toolConfirmReject'),
    });

    let dropdownOpen = false;
    const closeDropdown = () => {
        dropdown.hide();
        dropdownOpen = false;
    };

    const finalize = (approved: boolean) => {
        closeDropdown();
        dropdown.remove();
        (outsideClickDoc ?? activeDocument).removeEventListener('click', outsideClickHandler);
        const resolve = pendingConfirmations.get(messageId);
        if (resolve) {
            pendingConfirmations.delete(messageId);
            resolve(approved);
        }
        arrowWrap.remove();
        confirmRow.empty();
        if (approved) {
            confirmRow.createEl('span', {
                cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--allowed',
                text: t('view.toolConfirmAllowed'),
            });
        } else {
            const badge = confirmRow.createEl('span', {
                cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--rejected',
            });
            const icon = badge.createEl('span', { cls: 'session-bubble__tool-confirm-reject-icon' });
            setIcon(icon, 'alert-triangle');
            badge.createEl('span', { text: t('view.toolConfirmRejected') });
        }
    };

    allowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        finalize(true);
    });

    arrowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdownOpen) {
            closeDropdown();
        } else {
            const rect = arrowBtn.getBoundingClientRect();
            const layerRect = layer.getBoundingClientRect();
            dropdown.style.top = `${rect.bottom - layerRect.top + 4}px`;
            dropdown.style.left = `${rect.left - layerRect.left}px`;
            dropdown.show();
            dropdownOpen = true;
        }
    });

    rejectItem.addEventListener('click', (e) => {
        e.stopPropagation();
        finalize(false);
    });

    const outsideClickHandler = (ev: MouseEvent) => {
        if (!arrowWrap.contains(ev.target as Node) && !dropdown.contains(ev.target as Node)) {
            closeDropdown();
        }
    };
    let outsideClickDoc: Document | null = null;
    window.requestAnimationFrame(() => {
        outsideClickDoc = activeDocument;
        outsideClickDoc.addEventListener('click', outsideClickHandler);
    });
}

function renderToolConfirmBadge(container: HTMLElement, state: 'allowed' | 'rejected'): void {
    const confirmRow = container.createEl('div', { cls: 'session-bubble__tool-confirm' });
    if (state === 'allowed') {
        confirmRow.createEl('span', {
            cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--allowed',
            text: t('view.toolConfirmAllowed'),
        });
    } else {
        const badge = confirmRow.createEl('span', {
            cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--rejected',
        });
        const icon = badge.createEl('span', { cls: 'session-bubble__tool-confirm-reject-icon' });
        setIcon(icon, 'alert-triangle');
        badge.createEl('span', { text: t('view.toolConfirmRejected') });
    }
}
