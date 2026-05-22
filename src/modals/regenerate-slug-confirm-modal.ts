import { App } from 'obsidian';
import { t } from '../i18n';
import { PromiseModal } from './_promise-modal';

/**
 * Confirmation modal for regenerating an MCP server's slug.
 *
 * The slug determines the tool names exposed to the LLM (and referenced
 * by Skill files) as `mcp_${slug}_${toolName}`. Regenerating it changes
 * every such name in lockstep, which will break any Skill that hard-codes
 * the old names. This modal exists to make that consequence visible to
 * the user before they pull the trigger.
 *
 * The body lists the old → new tool name mapping for every currently
 * known tool on the server so the user sees the exact diff, plus a
 * standout warning that Skill references will stop working.
 *
 * Usage:
 *   const { confirmed } = await new RegenerateSlugConfirmModal(
 *       app, oldSlug, newSlug, toolNames,
 *   ).waitForResult();
 */
export interface RegenerateSlugConfirmResult {
	confirmed: boolean;
}

export class RegenerateSlugConfirmModal extends PromiseModal<RegenerateSlugConfirmResult> {
	constructor(
		app: App,
		private readonly oldSlug: string,
		private readonly newSlug: string,
		/** Upstream tool names belonging to the server (no `mcp_…_` prefix). */
		private readonly toolNames: string[],
	) {
		super(app);
	}

	protected cancelValue(): RegenerateSlugConfirmResult {
		return { confirmed: false };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oap-regenerate-slug-modal');

		this.setTitle(t('mcp.regenerateSlugTitle'));

		const body = contentEl.createDiv({ cls: 'oap-regenerate-slug-modal__body' });

		body.createEl('p', {
			cls: 'oap-regenerate-slug-modal__summary',
			text: t('mcp.regenerateSlugSummary', { oldSlug: this.oldSlug, newSlug: this.newSlug }),
		});

		// ── Tool-name diff ────────────────────────────────────────────
		// Show the exact strings the model (and the user's Skill files)
		// will see before / after. Capped at 8 rows so a server with 50
		// tools doesn't make the modal scroll into infinity; remaining
		// rows are summarised by a "+N more" footnote.
		if (this.toolNames.length > 0) {
			const list = body.createEl('ul', {
				cls: 'oap-regenerate-slug-modal__diff',
			});
			const MAX_ROWS = 8;
			const shown = this.toolNames.slice(0, MAX_ROWS);
			for (const toolName of shown) {
				const li = list.createEl('li', {
					cls: 'oap-regenerate-slug-modal__diff-row',
				});
				li.createEl('code', { text: `mcp_${this.oldSlug}_${toolName}` });
				li.createSpan({ text: '  →  ', cls: 'oap-regenerate-slug-modal__diff-arrow' });
				li.createEl('code', { text: `mcp_${this.newSlug}_${toolName}` });
			}
			if (this.toolNames.length > MAX_ROWS) {
				body.createEl('p', {
					cls: 'oap-regenerate-slug-modal__diff-more',
					text: t('mcp.regenerateSlugMoreTools', { count: this.toolNames.length - MAX_ROWS }),
				});
			}
		} else {
			body.createEl('p', {
				cls: 'oap-regenerate-slug-modal__no-tools',
				text: t('mcp.regenerateSlugNoTools'),
			});
		}

		// Standout warning — Skill references will break.
		body.createEl('p', {
			cls: 'oap-regenerate-slug-modal__warning',
			text: t('mcp.regenerateSlugWarning'),
		});

		// ── Buttons ───────────────────────────────────────────────────
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });

		const cancelBtn = btnRow.createEl('button', { cls: 'oap-regenerate-slug-modal__btn' });
		cancelBtn.setText(t('common.cancel'));
		cancelBtn.addEventListener('click', () => {
			this.resolve({ confirmed: false });
			this.close();
		});

		const confirmBtn = btnRow.createEl('button', {
			cls: 'mod-warning oap-regenerate-slug-modal__btn oap-regenerate-slug-modal__btn--confirm',
		});
		confirmBtn.setText(t('mcp.regenerateSlugConfirm'));
		confirmBtn.addEventListener('click', () => {
			this.resolve({ confirmed: true });
			this.close();
		});
	}

	onClose() {
		// PromiseModal forwards the cancel value to any unresolved promise.
		super.onClose();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('oap-regenerate-slug-modal');
	}
}
