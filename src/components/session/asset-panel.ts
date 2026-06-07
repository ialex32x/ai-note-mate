import { setIcon, setTooltip, type App, TFile } from 'obsidian';
import type { GeneratedAsset } from '../../services/generated-asset-collection';
import { t } from '../../i18n';

/**
 * Renders the generated-asset button (in the session toolbar) and its
 * popup panel (grid of 64×64 image thumbnails).
 *
 * The button hides when there are zero assets.  When clicked it opens a
 * dropdown whose content is re-rendered on every open so it stays in
 * sync with the live collection.
 *
 * Lifecycle note: the view is responsible for calling
 * {@link updateVisibility} when the runtime (and therefore the
 * underlying {@link GeneratedAssetCollection}) changes.
 */
export class AssetPanelButton {
	private buttonEl!: HTMLElement;
	private panelEl!: HTMLElement;
	/** Active detach fn for the collection change listener, if any. */
	private detachListener?: () => void;

	constructor(
		private readonly app: App,
		private readonly getAssets: () => ReadonlyArray<GeneratedAsset>,
	) {}

	/**
	 * Create the button and dropdown-panel DOM inside `container`.
	 *
	 * Returns `{ button, dropdown }` so the caller can register the
	 * toggle with {@link DropdownManager} and wire `onOpen` → `renderPanel`.
	 */
	mount(container: HTMLElement): { button: HTMLElement; dropdown: HTMLElement } {
		const wrapper = container.createEl('div', { cls: 'session-toolbar__status' });

		this.buttonEl = wrapper.createEl('div', {
			cls: 'session-toolbar__status-main asset-panel-btn',
			attr: { role: 'button', tabindex: '0' },
		});
		setTooltip(this.buttonEl, t('assetPanel.title'));

		const iconEl = this.buttonEl.createEl('span', { cls: 'asset-panel-btn__icon' });
		setIcon(iconEl, 'image');

		this.panelEl = wrapper.createEl('div', {
			cls: 'session-dropdown-menu session-dropdown-menu--toolbar-up-right session-status-panel asset-panel',
		});

		this.updateVisibility();

		return { button: this.buttonEl, dropdown: this.panelEl };
	}

	/**
	 * Bind to a new collection's change events.
	 * Unsubscribes the previous listener (if any) first.
	 */
	bindCollection(onChange: (listener: () => void) => () => void): void {
		this.detachListener?.();
		this.detachListener = onChange(() => this.updateVisibility());
		this.updateVisibility();
	}

	/**
	 * Render the thumbnail grid into the dropdown panel.
	 * Called on every dropdown-open so the content reflects the latest
	 * collection state.
	 */
	renderPanel(): void {
		this.panelEl.empty();

		const assets = this.getAssets();
		const count = assets.length;

		// Header
		const header = this.panelEl.createEl('div', { cls: 'asset-panel__header' });
		header.createEl('span', { cls: 'asset-panel__title', text: t('assetPanel.title') });
		header.createEl('span', { cls: 'asset-panel__count', text: `(${count})` });

		if (count === 0) {
			const empty = this.panelEl.createEl('div', { cls: 'asset-panel__empty' });
			empty.setText(t('assetPanel.empty'));
			return;
		}

		// Thumbnail grid — newest assets at bottom, scroll to end on open
		const grid = this.panelEl.createEl('div', { cls: 'asset-panel__grid' });

		for (const asset of assets) {
			const cell = grid.createEl('div', { cls: 'asset-panel__cell' });
			const thumb = cell.createEl('div', { cls: 'asset-panel__thumb' });

			try {
				const file = this.app.vault.getAbstractFileByPath(asset.path);
				if (file instanceof TFile) {
					const url = this.app.vault.getResourcePath(file);
					const img = thumb.createEl('img', {
						cls: 'asset-panel__img',
						attr: { src: url, loading: 'lazy' },
					});
					setTooltip(img, asset.path);
				} else {
					this.renderBrokenIcon(thumb);
				}
			} catch {
				this.renderBrokenIcon(thumb);
			}

			// Click to open the asset in Obsidian
			cell.addEventListener('click', () => {
				const file = this.app.vault.getAbstractFileByPath(asset.path);
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf().openFile(file);
				}
			});
		}

		// Scroll to bottom so the newest assets are visible
		window.requestAnimationFrame(() => {
			grid.scrollTop = grid.scrollHeight;
		});
	}

	/** Update button visibility. */
	updateVisibility(): void {
		this.buttonEl.style.display = this.getAssets().length === 0 ? 'none' : '';
	}

	dispose(): void {
		this.detachListener?.();
		this.detachListener = undefined;
	}

	private renderBrokenIcon(container: HTMLElement): void {
		container.createEl('span', {
			cls: 'asset-panel__broken',
			text: '?',
		});
	}
}
