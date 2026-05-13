import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Modal that displays a searchable list of available models.
 * The modal body contains only a search input and the model list — no extra chrome.
 *
 * Usage:
 *   const model = await new ModelSelectorModal(app, models, currentModel).waitForResult();
 */
export class ModelSelectorModal extends Modal {
	private resultResolver: ((model: string | null) => void) | null = null;
	private resolved = false;

	constructor(
		app: App,
		private models: string[],
		private currentModel: string,
	) {
		super(app);
	}

	/** Opens the modal and resolves with the selected model or null. */
	waitForResult(): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			this.resultResolver = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();

		// Strip default modal padding/title — we only want the list
		modalEl.addClass('oap-model-selector-modal');

		// Search input
		const searchInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: t('settings.searchModels'),
			cls: 'oap-model-suggester__search',
		});

		// Model list container
		const listContainer = contentEl.createDiv({ cls: 'oap-model-suggester__list' });

		const renderList = (filter: string) => {
			listContainer.empty();
			const filtered = filter
				? this.models.filter(m => m.toLowerCase().includes(filter.toLowerCase()))
				: this.models;

			for (const model of filtered) {
				const item = listContainer.createDiv({
					cls: `oap-model-suggester__item${model === this.currentModel ? ' is-active' : ''}`,
					text: model,
				});
				item.addEventListener('click', () => {
					this.resolve(model);
					this.close();
				});
			}

			if (filtered.length === 0) {
				listContainer.createDiv({
					cls: 'oap-model-suggester__empty',
					text: t('settings.noModelsFound'),
				});
			}
		};

		renderList('');

		searchInput.addEventListener('input', () => {
			renderList(searchInput.value);
		});

		searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.resolve(null);
				this.close();
			}
		});

		// Focus search input
		window.requestAnimationFrame(() => searchInput.focus());
	}

	onClose() {
		this.resolve(null);
		this.contentEl.empty();
	}

	private resolve(value: string | null) {
		if (this.resolved) return;
		this.resolved = true;
		this.resultResolver?.(value);
		this.resultResolver = null;
	}
}
