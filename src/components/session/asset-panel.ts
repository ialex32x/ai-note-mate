import { setIcon, setTooltip, Notice, type App, TFile } from 'obsidian';
import type { GeneratedAsset } from '../../services/generated-asset-collection';
import { t } from '../../i18n';

/**
 * Renders the generated-asset button (in the session toolbar) and its
 * popup panel (list of assets with thumbnail + details).
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
		const wrapper = container.createDiv({ cls: 'session-toolbar__status session-asset-wrapper' });

		this.buttonEl = wrapper.createDiv({
			cls: 'session-toolbar__status-main asset-panel-btn',
			attr: { role: 'button', tabindex: '0' },
		});
		setTooltip(this.buttonEl, t('assetPanel.title'));

		const iconEl = this.buttonEl.createSpan({ cls: 'asset-panel-btn__icon' });
		setIcon(iconEl, 'image');

		this.panelEl = wrapper.createDiv({
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
	 * Render the asset list into the dropdown panel.
	 * Called on every dropdown-open so the content reflects the latest
	 * collection state.
	 */
	renderPanel(): void {
		this.panelEl.empty();

		const assets = this.getAssets();
		const count = assets.length;

		// Header
		const header = this.panelEl.createDiv({ cls: 'asset-panel__header' });
		header.createSpan({ cls: 'asset-panel__title', text: t('assetPanel.title') });
		header.createSpan({ cls: 'asset-panel__count', text: `(${count})` });

		if (count === 0) {
			const empty = this.panelEl.createDiv({ cls: 'asset-panel__empty' });
			empty.setText(t('assetPanel.empty'));
			return;
		}

		// List layout — one row per asset, newest at bottom
		const list = this.panelEl.createDiv({ cls: 'asset-panel__list' });

		for (const asset of assets) {
			const row = list.createDiv({ cls: 'asset-panel__row' });

			// Thumbnail
			const thumb = row.createDiv({ cls: 'asset-panel__thumb' });

			// Info area (2 lines)
			const info = row.createDiv({ cls: 'asset-panel__info' });

			let file: TFile | null = null;
			try {
				const f = this.app.vault.getAbstractFileByPath(asset.path);
				if (f instanceof TFile) {
					file = f;
				}
			} catch { /* file not found — handled below */ }

			if (file) {
				const url = this.app.vault.getResourcePath(file);

				thumb.createEl('img', {
					cls: 'asset-panel__img',
					attr: { src: url, loading: 'lazy' },
				});

				// Line 1: file path
				info.createDiv({ cls: 'asset-panel__info-path', text: asset.path });

				// Line 2: file size + creation time
				const metaEl = info.createDiv({ cls: 'asset-panel__info-meta' });
				const stat = file.stat;
				metaEl.setText(`${this.formatFileSize(stat.size)} · ${new Date(stat.ctime).toLocaleString()}`);
			} else {
				this.renderBrokenIcon(thumb);
				info.createDiv({ cls: 'asset-panel__info-path', text: asset.path });
				info.createDiv({ cls: 'asset-panel__info-meta', text: '' });
			}

			// Click to open the asset in Obsidian
			row.addEventListener('click', () => {
				const f = this.app.vault.getAbstractFileByPath(asset.path);
				if (f instanceof TFile) {
					void this.app.workspace.getLeaf().openFile(f);
				} else {
					new Notice(t('assetPanel.deleted', { path: asset.path }));
				}
			});
		}

		// Scroll to bottom so the newest assets are visible
		window.requestAnimationFrame(() => {
			list.scrollTop = list.scrollHeight;
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
		container.createSpan({
			cls: 'asset-panel__broken',
			text: '?',
		});
	}

	/** Format file size in human-readable form. */
	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
}
