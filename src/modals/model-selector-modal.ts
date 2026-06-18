import { App } from 'obsidian';
import { t } from '../i18n';
import { PromiseModal } from './_promise-modal';
import { createCopyButton } from '../utils/copy-button';

/**
 * Modal that displays a searchable list of available models.
 * The modal body contains only a search input and the model list — no extra chrome.
 *
 * Usage:
 *   const model = await new ModelSelectorModal(app, models, currentModel).waitForResult();
 */
export class ModelSelectorModal extends PromiseModal<string | null> {
	constructor(
		app: App,
		private models: string[],
		private currentModel: string,
	) {
		super(app);
	}

	protected cancelValue(): string | null {
		return null;
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
				});

				item.createSpan({ cls: 'oap-model-suggester__item-name', text: model });

				const copyBtn = createCopyButton(
					t('common.copy'),
					() => model,
					'oap-model-suggester__copy-btn',
				);
				item.appendChild(copyBtn);

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
		super.onClose();
		this.contentEl.empty();
	}
}
