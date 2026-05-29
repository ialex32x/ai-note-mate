import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Modal dialog for editing the system prompt (initial prompt).
 */
export class SystemPromptModal extends Modal {
	private textarea!: HTMLTextAreaElement;
	private saved = false;
	private cancelled = false;
	
	/** Callback when user saves the prompt */
	onSave: ((value: string) => void | Promise<void>) | null = null;

	constructor(
		app: App,
		private currentValue: string,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('system-prompt-modal');

		this.setTitle(t('settings.initialPrompt'));

		// Textarea container
		const textareaContainer = contentEl.createDiv({ cls: 'system-prompt-modal__textarea-container' });
		this.textarea = textareaContainer.createEl('textarea', {
			cls: 'system-prompt-modal__textarea',
			attr: {
				placeholder: t('settings.initialPromptPlaceholder'),
			},
		});
		this.textarea.value = this.currentValue;

		// Auto-resize textarea
		const resizeTextarea = () => {
			// Reset to CSS default so scrollHeight reflects intrinsic content height.
			this.textarea.style.removeProperty('height');
			this.textarea.style.height = `${Math.min(400, this.textarea.scrollHeight)}px`;
		};
		resizeTextarea();
		this.textarea.addEventListener('input', resizeTextarea);

		// Button row
		const btnRow = contentEl.createDiv({ cls: 'system-prompt-modal__btn-row' });

		const cancelBtn = btnRow.createEl('button', {
			cls: 'system-prompt-modal__btn system-prompt-modal__btn--cancel',
			text: t('common.cancel'),
		});
		cancelBtn.addEventListener('click', () => {
			this.cancelled = true;
			this.close();
		});

		const saveBtn = btnRow.createEl('button', {
			cls: 'system-prompt-modal__btn system-prompt-modal__btn--save',
			text: t('common.save'),
		});
		saveBtn.addEventListener('click', () => this.handleSave());

		// Keyboard shortcuts
		this.textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.cancelled = true;
				this.close();
			}
			// Ctrl/Cmd + Enter to save
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.handleSave();
			}
		});

		// Auto-focus textarea
		window.setTimeout(() => this.textarea.focus(), 50);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('system-prompt-modal');
		
		// Save on close if not already saved and not cancelled (handles click-outside)
		if (!this.saved && !this.cancelled && this.onSave) {
			void this.onSave(this.textarea.value);
		}
	}

	private handleSave() {
		this.saved = true;
		if (this.onSave) {
			void this.onSave(this.textarea.value);
		}
		this.close();
	}
}
