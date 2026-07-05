import { setIcon, TFile } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { prettifyIfJson } from '../../utils/json-format';
import { createCopyButton } from '../../utils/copy-button';
import { createCollapsible, COLLAPSIBLE_CLASSES } from '../../utils/collapsible';
import type { BubbleContext } from './bubble-context';
import { openAnchoredDropdown, type AnchoredDropdownHandle } from './anchored-dropdown';

/** Regex to parse markdown image syntax: ![alt](path) */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

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
    onPreviewImage?: (src: string, fileName: string) => void,
): void {
    const hasDetail = !!(msg.toolCallMeta || msg.toolCallResult);
    const labelText = msg.streaming ? `${msg.content}  …` : msg.content;

    if (!hasDetail) {
        renderToolHeaderStatic(contentEl, msg, labelText);
    } else {
        renderToolDetail(contentEl, msg, labelText, wasToolDetailExpanded);
    }

    // Render generated image thumbnails on the bubble surface so the user
    // can see them without expanding the detail section.
    const isImageGenSuccess =
        msg.toolCallMeta?.toolName === 'generate_image' &&
        msg.toolCallResult?.status === 'success';
    if (isImageGenSuccess) {
        renderGeneratedImages(contentEl, msg, ctx, onPreviewImage);
    }

    if (msg.confirmationState === 'pending' && msg.streaming) {
        renderToolConfirmPending(ctx, contentEl, msg.id, pendingConfirmations);
    } else if (msg.confirmationState === 'allowed' || msg.confirmationState === 'rejected') {
        renderToolConfirmBadge(contentEl, msg.confirmationState);
    }
}

/**
 * Render a non-collapsible tool header (used while the tool call has neither
 * args metadata nor a result yet — e.g. mid-stream before the first chunk).
 *
 * Wraps in a `.collapsible-block.collapsible-block--tool` so the same
 * header styling rules apply as the collapsible variant; just omits the
 * arrow + body + click handler since there's nothing to expand.
 */
function renderToolHeaderStatic(
    contentEl: HTMLElement,
    msg: ChatMessage,
    labelText: string,
): void {
    const wrapper = contentEl.createDiv({
        cls: 'collapsible-block collapsible-block--tool collapsible-block--tool-static',
    });
    const header = wrapper.createSpan({ cls: 'collapsible-block__header' });
    header.createSpan({
        cls: 'collapsible-block--tool__label',
        text: labelText,
    });
    appendToolStatusIcon(header, msg);
}

/**
 * Render the collapsible detail section (Arguments + Result) for a tool call.
 * Detail body content is built lazily on first expand to keep large tool
 * outputs out of the DOM until the user actually opens them.
 */
function renderToolDetail(
    contentEl: HTMLElement,
    msg: ChatMessage,
    labelText: string,
    wasToolDetailExpanded: boolean,
): void {
    const collapsible = createCollapsible(contentEl, {
        summary: labelText,
        initiallyExpanded: wasToolDetailExpanded,
        ariaLabel: 'Toggle tool call detail',
        summaryClass: 'collapsible-block--tool__label',
    });

    collapsible.wrapper.addClass('collapsible-block--tool');
    collapsible.wrapper.addClass('collapsible-block--code');

    appendToolStatusIcon(collapsible.header, msg);

    let bodyPopulated = false;
    const ensureBody = () => {
        if (bodyPopulated) return;
        bodyPopulated = true;
        populateToolDetailBody(collapsible.body, msg);
    };
    if (wasToolDetailExpanded) {
        ensureBody();
    }
    collapsible.header.addEventListener('click', ensureBody);
    collapsible.header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') ensureBody();
    });
}

/** Append the success / warning / error glyph to a tool header element. */
function appendToolStatusIcon(headerEl: HTMLElement, msg: ChatMessage): void {
    if (!msg.toolCallResult) return;
    const statusIcon =
        msg.toolCallResult.status === 'error' ? '✕' :
        msg.toolCallResult.status === 'warning' ? '⚠' :
        '✓';
    headerEl.createSpan({
        cls: `collapsible-block--tool__status collapsible-block--tool__status--${msg.toolCallResult.status}`,
        text: statusIcon,
    });
}

function populateToolDetailBody(detailBody: HTMLElement, msg: ChatMessage): void {
    if (msg.toolCallMeta) {
        renderToolDetailSection(detailBody, 'Arguments', () => {
            return JSON.stringify(msg.toolCallMeta?.toolArgs ?? null, null, 2);
        }, t('view.copyToolArgs'), () => {
            const args = msg.toolCallMeta?.toolArgs;
            return args === undefined ? '' : JSON.stringify(args, null, 2);
        });
    }

    if (msg.toolCallResult) {
        renderToolDetailSection(detailBody, 'Result', () => {
            const text = msg.toolCallResult?.result ?? '';
            return text.length > 2000 ? text.slice(0, 2000) + '\n... (truncated)' : text;
        }, t('view.copyToolResult'), () => {
            return prettifyIfJson(msg.toolCallResult?.result ?? '');
        });
    }
}

/**
 * Single shared "labelled code section" pattern used for both Arguments
 * and Result panels in the tool detail body. The pattern is: a small
 * uppercase label, a code-wrap with a `<pre>` containing the displayed
 * text, and a hover-reveal copy button that returns the full (possibly
 * untruncated, possibly prettified) text from the message.
 */
function renderToolDetailSection(
    detailBody: HTMLElement,
    label: string,
    getDisplayText: () => string,
    copyTooltip: string,
    getCopyText: () => string,
): void {
    const wrapper = detailBody.createDiv({ cls: 'collapsible-block__section' });
    wrapper.createSpan({
        cls: 'collapsible-block__section-label',
        text: label,
    });
    const codeWrap = wrapper.createDiv({ cls: COLLAPSIBLE_CLASSES.CODE_WRAP });
    const codePre = codeWrap.createEl('pre', { cls: COLLAPSIBLE_CLASSES.CODE });
    codePre.setText(getDisplayText());
    const copyBtn = createCopyButton(copyTooltip, getCopyText, COLLAPSIBLE_CLASSES.COPY_BTN);
    codeWrap.appendChild(copyBtn);
}

/**
 * Render generated image thumbnails inline on the tool-call bubble surface.
 * Each image is a small clickable thumbnail that opens the preview overlay.
 */
function renderGeneratedImages(
    container: HTMLElement,
    msg: ChatMessage,
    ctx: BubbleContext,
    onPreviewImage?: (src: string, fileName: string) => void,
): void {
    const resultText = msg.toolCallResult?.result ?? '';
    // Use exec() loop instead of matchAll() for ES2019 lib compatibility
    const re = new RegExp(MARKDOWN_IMAGE_RE.source, MARKDOWN_IMAGE_RE.flags);
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(resultText)) !== null) {
        matches.push(match);
    }
    if (matches.length === 0) return;

    const imagesRow = container.createDiv({ cls: 'session-bubble__attachments' });

    for (const match of matches) {
        const altText: string = match[1] ?? '';
        const vaultPath: string = match[2] ?? '';
        const file = ctx.app.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) continue;

        const src = ctx.app.vault.getResourcePath(file);
        const fileName = file.name;

        const img = imagesRow.createEl('img', {
            cls: 'session-bubble__attachment-img',
            attr: {
                src,
                alt: altText || fileName,
                title: fileName,
            },
        });

        if (onPreviewImage) {
            img.addEventListener('click', (e) => {
                e.stopPropagation();
                onPreviewImage(src, fileName);
            });
        }
    }
}

function renderToolConfirmPending(
    ctx: BubbleContext,
    container: HTMLElement,
    messageId: string,
    pendingConfirmations: Map<string, (approved: boolean) => void>,
): void {
    const confirmRow = container.createDiv({ cls: 'session-bubble__tool-confirm' });

    const allowBtn = confirmRow.createEl('button', {
        cls: 'session-bubble__tool-confirm-btn',
        text: t('view.toolConfirmApprove'),
        attr: { type: 'button' },
    });

    const arrowWrap = confirmRow.createSpan({ cls: 'session-bubble__tool-confirm-arrow-wrap' });
    const arrowBtn = arrowWrap.createEl('button', {
        cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-arrow',
        attr: { type: 'button', 'aria-label': 'More options' },
    });
    setIcon(arrowBtn, 'chevron-down');

    let dropdown: AnchoredDropdownHandle | null = null;

    const finalize = (approved: boolean) => {
        dropdown?.close();
        dropdown = null;
        const resolve = pendingConfirmations.get(messageId);
        if (resolve) {
            pendingConfirmations.delete(messageId);
            resolve(approved);
        }
        arrowWrap.remove();
        confirmRow.empty();
        renderToolConfirmResult(confirmRow, approved ? 'allowed' : 'rejected');
    };

    allowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        finalize(true);
    });

    arrowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown) {
            dropdown.close();
            dropdown = null;
            return;
        }
        dropdown = openAnchoredDropdown(ctx, {
            anchor: arrowBtn,
            placement: 'below',
            cls: 'session-bubble__tool-confirm-dropdown',
            attr: { 'data-confirm-msg-id': messageId },
            insideRegions: [arrowWrap],
            onClose: () => { dropdown = null; },
            build: (menu, close) => {
                const rejectItem = menu.createDiv({
                    cls: 'session-dropdown-item session-bubble__tool-confirm-dropdown-item',
                    text: t('view.toolConfirmReject'),
                });
                rejectItem.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    close();
                    finalize(false);
                });
            },
        });
    });
}

function renderToolConfirmBadge(container: HTMLElement, state: 'allowed' | 'rejected'): void {
    const confirmRow = container.createDiv({ cls: 'session-bubble__tool-confirm' });
    renderToolConfirmResult(confirmRow, state);
}

/**
 * Render the "已批准 / 已拒绝" result chip into an existing confirm row.
 * Shared between {@link renderToolConfirmBadge} (replay path, drawn on
 * historical messages) and the inline `finalize` path inside
 * {@link renderToolConfirmPending} once the user makes a decision.
 */
function renderToolConfirmResult(confirmRow: HTMLElement, state: 'allowed' | 'rejected'): void {
    if (state === 'allowed') {
        confirmRow.createSpan({
            cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--allowed',
            text: t('view.toolConfirmAllowed'),
        });
    } else {
        const badge = confirmRow.createSpan({
            cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--rejected',
        });
        const icon = badge.createSpan({ cls: 'session-bubble__tool-confirm-reject-icon' });
        setIcon(icon, 'alert-triangle');
        badge.createSpan({ text: t('view.toolConfirmRejected') });
    }
}
