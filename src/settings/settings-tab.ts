import { App, PluginSettingTab } from "obsidian";
import NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import { createSettingsSection, setAdvancedSettingsVisible } from "../components/settings-components";
import { SectionAnchorNav } from "../components/settings-anchor-nav";
import {
	AgentsSettingsSection,
	EmbeddingSettingsSection,
	GlobalSettingsSection,
	ImageGenSettingsSection,
	MemorySettingsSection,
	SpeechToTextSettingsSection,
	TextGenSettingsSection,
	SectionContext,
	SettingsSection,
	SkillSettingsSection,
	ToolsSettingsSection,
} from "./sections";
import { getProfileLabel } from "./sections/global-section";

export class NoteAssistantSettingTab extends PluginSettingTab {
	plugin: NoteAssistantPlugin;

	private readonly sections: SettingsSection[];
	/** Per-section body elements, populated on each display() call. */
	private sectionBodies: HTMLElement[] = [];
	/** Outer section cards (parent of each body), used as anchor targets. */
	private sectionCards: HTMLElement[] = [];
	private anchorNav: SectionAnchorNav | null = null;

	/** Per-section header action elements, populated on each display() call. */
	private headerActionsEls: HTMLElement[] = [];

	constructor(app: App, plugin: NoteAssistantPlugin) {
		super(app, plugin);
		this.plugin = plugin;

		const ctx: SectionContext = {
			app,
			plugin,
			containerEl: this.containerEl,
			refreshAll: () => this.display(),
			refreshSection: (section) => this.refreshSection(section),
			onProfilesChanged: () => this.rebuildGlobalProfileDropdowns(),
		};

		// Order here defines the display order of sections in the tab
		this.sections = [
			new GlobalSettingsSection(ctx),
			new TextGenSettingsSection(ctx),
			new EmbeddingSettingsSection(ctx),
			new ImageGenSettingsSection(ctx),
			new SpeechToTextSettingsSection(ctx),
			new ToolsSettingsSection(ctx),
			new AgentsSettingsSection(ctx),
			new SkillSettingsSection(ctx),
			new MemorySettingsSection(ctx),
		];
	}

	display(): void {
		const { containerEl } = this;
		// Preserve scroll position across full rebuilds as a safety net;
		// most UI updates should go through `refreshSection` instead.
		const prevScrollTop = containerEl.scrollTop;

		// Release any resources held by sections from the previous render
		// (e.g. MCP state listeners) before wiping the DOM.
		for (const section of this.sections) {
			section.dispose?.();
		}

		// Tear down a previous anchor nav (if any) before wiping the DOM.
		this.anchorNav?.destroy();
		this.anchorNav = null;

		containerEl.empty();

		setAdvancedSettingsVisible(this.plugin.settings.showAdvanced);

		// Host for the sticky anchor nav; placed before all sections so it
		// sits at the top of the scroll container.
		const anchorHost = containerEl.createDiv();

		this.sectionBodies = [];
		this.headerActionsEls = [];
		this.sectionCards = [];
		const anchorItems: {
			id: string;
			title: string;
			bodyEl: HTMLElement;
		}[] = [];
		for (const section of this.sections) {
			const { body, headerActions } = createSettingsSection(containerEl, t(section.titleKey));
			section.render(body);
			if (section.renderHeaderActions) {
				section.renderHeaderActions(headerActions);
			}
			this.sectionBodies.push(body);
			this.headerActionsEls.push(headerActions);
			// `createSettingsSection` returns the inner body; the outer card
			// is its parent and is the element we want to observe/scroll to.
			// Fall back to the body itself to keep the anchor list aligned
			// with `this.sections`.
			const card = body.parentElement ?? body;
			this.sectionCards.push(card);
			anchorItems.push({
				id: section.titleKey,
				title: t(section.titleKey),
				bodyEl: card,
			});
		}

		this.anchorNav = new SectionAnchorNav(anchorHost, {
			scrollContainer: containerEl,
			items: anchorItems,
		});

		containerEl.scrollTop = prevScrollTop;

		// After initial render, ensure each section's editing tab is visible.
		for (const body of this.sectionBodies) {
			const tabScroll = body.querySelector<HTMLElement>('.oap-profile-tabs__scroll');
			if (tabScroll) this.scrollEditingTabIntoView(tabScroll);
		}
	}

	hide(): void {
		for (const section of this.sections) {
			section.dispose?.();
		}
		this.anchorNav?.destroy();
		this.anchorNav = null;
		super.hide();
	}

	/**
	 * Smoothly scroll the settings panel to the section whose
	 * `titleKey` matches `id`. Used by deep-link entry points like the
	 * onboarding tips popover ("Try it" → open settings + jump to
	 * Embedding) so they don't have to duplicate sticky-nav-aware
	 * scroll math.
	 *
	 * Safe to call when the panel hasn't rendered yet — the request is
	 * silently dropped (the next `display()` will not auto-rescroll, so
	 * callers should invoke this *after* the tab has been switched on).
	 */
	scrollToSection(id: string): void {
		this.anchorNav?.scrollToItem(id);
	}

	/**
	 * Re-render a single section in place without rebuilding the whole tab.
	 * Preserves the horizontal scroll position of the section's internal tab
	 * bar (if any) so switching between profiles / configs / servers doesn't
	 * reset the tab bar to the leftmost position.
	 */
	private refreshSection(section: SettingsSection): void {
		const idx = this.sections.indexOf(section);
		if (idx < 0) return;
		const body = this.sectionBodies[idx];
		const headerActions = this.headerActionsEls[idx];
		if (!body) {
			// Not yet mounted (or already detached) — fall back to full display.
			this.display();
			return;
		}

		// Save the horizontal scroll position of any internal tab bar
		// before we destroy it, so we can restore it after re-render.
		const oldTabScroll = body.querySelector<HTMLElement>('.oap-profile-tabs__scroll');
		const savedScrollLeft = oldTabScroll?.scrollLeft ?? 0;

		body.empty();
		setAdvancedSettingsVisible(this.plugin.settings.showAdvanced);
		section.render(body);

		// Restore the tab bar scroll position on the newly created element.
		const newTabScroll = body.querySelector<HTMLElement>('.oap-profile-tabs__scroll');
		if (newTabScroll) {
			newTabScroll.scrollLeft = savedScrollLeft;
			this.scrollEditingTabIntoView(newTabScroll);
		}

		if (headerActions && section.renderHeaderActions) {
			headerActions.empty();
			section.renderHeaderActions(headerActions);
		}
	}

	/**
	 * Ensure the editing tab inside `tabScroll` is fully visible.
	 * Adjusts `scrollLeft` only when the tab is partially off-screen;
	 * leaves a small peek into the neighbouring tab when there are more
	 * tabs on that side.
	 */
	private scrollEditingTabIntoView(tabScroll: HTMLElement): void {
		const editingTab = tabScroll.querySelector<HTMLElement>('.oap-profile-tab--active');
		if (!editingTab) return;

		const scrollRect = tabScroll.getBoundingClientRect();
		const tabRect = editingTab.getBoundingClientRect();
		// Already fully visible — nothing to do.
		if (tabRect.left >= scrollRect.left && tabRect.right <= scrollRect.right) return;

		const PEEK_OFFSET = 48;
		const canScrollLeft = tabScroll.scrollLeft > 0;
		const canScrollRight =
			tabScroll.scrollLeft + tabScroll.clientWidth <
			tabScroll.scrollWidth - 1;

		if (tabRect.right > scrollRect.right) {
			tabScroll.scrollLeft +=
				tabRect.right - scrollRect.right +
				(canScrollRight ? PEEK_OFFSET : 0);
		}
		if (tabRect.left < scrollRect.left) {
			tabScroll.scrollLeft -=
				scrollRect.left - tabRect.left +
				(canScrollLeft ? PEEK_OFFSET : 0);
		}
	}

	/**
	 * Rebuild all config-related dropdowns in the Global section in-place.
	 *
	 * Handles every {@code <select>} in the Global section body whose
	 * options map to profile / embedding / image-gen / speech-to-text config IDs.
	 * Preserves the currently-selected value when it still exists;
	 * otherwise falls back to the first item of that list.
	 *
	 * Triggered by {@link SectionContext.onProfilesChanged} whenever any
	 * config list is mutated (add / delete / duplicate) or a config label
	 * changes (name / model edit).
	 */
	private rebuildGlobalProfileDropdowns(): void {
		const globalSectionIdx = this.sections.findIndex(
			s => s instanceof GlobalSettingsSection,
		);
		if (globalSectionIdx < 0) return;
		const body = this.sectionBodies[globalSectionIdx];
		if (!body) return;

		const { settings } = this.plugin;
		const profileIds = new Set(settings.profiles.map(p => p.id));
		const embeddingIds = new Set(settings.embeddingConfigs.map(c => c.id));
		const imageGenIds = new Set(settings.imageGenConfigs.map(c => c.id));
		const sttIds = new Set(settings.speechToTextConfigs.map(c => c.id));

		const selects = body.querySelectorAll<HTMLSelectElement>('select');
		for (const select of Array.from(selects)) {
			const firstOpt = select.options[0];
			if (!firstOpt) continue;

			const savedValue = select.value;
			const firstVal = firstOpt.value;

			if (profileIds.has(firstVal)) {
				this.rebuildSelect(select, settings.profiles, savedValue, profileIds,
					p => getProfileLabel(p));
			} else if (firstVal === '' && select.options.length > 1 && embeddingIds.has(select.options[1]!.value)) {
				// Embedding dropdown: first option is "None" (value=''),
				// second option is the first actual embedding config.
				this.rebuildEmbeddingSelect(select, settings.embeddingConfigs, savedValue, embeddingIds);
			} else if (embeddingIds.has(firstVal)) {
				this.rebuildSelect(select, settings.embeddingConfigs, savedValue, embeddingIds,
					c => c.name || 'Unnamed');
			} else if (imageGenIds.has(firstVal)) {
				this.rebuildSelect(select, settings.imageGenConfigs, savedValue, imageGenIds,
					c => c.name || 'Unnamed');
			} else if (sttIds.has(firstVal)) {
				this.rebuildSelect(select, settings.speechToTextConfigs, savedValue, sttIds,
					c => c.name || 'Unnamed');
			}
		}
	}

	/**
	 * Rebuild a single {@code <select>} element's option list from a
	 * config array, then restore or fallback the selection.
	 */
	private rebuildSelect<T extends { id: string }>(
		select: HTMLSelectElement,
		items: T[],
		savedValue: string,
		validIds: Set<string>,
		labelFn: (item: T) => string,
	): void {
		select.innerHTML = '';
		for (const item of items) {
			const opt = activeDocument.createElement('option');
			opt.value = item.id;
			opt.textContent = labelFn(item);
			select.appendChild(opt);
		}
		if (validIds.has(savedValue)) {
			select.value = savedValue;
		} else if (items.length > 0) {
			select.value = items[0]!.id;
		}
	}

	/**
	 * Rebuild the embedding config dropdown, preserving the "None" option.
	 */
	private rebuildEmbeddingSelect<T extends { id: string }>(
		select: HTMLSelectElement,
		items: T[],
		savedValue: string,
		validIds: Set<string>,
	): void {
		select.innerHTML = '';
		// "None" option first
		const noneOpt = activeDocument.createElement('option');
		noneOpt.value = '';
		noneOpt.textContent = t('settings.embeddingNone');
		select.appendChild(noneOpt);
		// Config options
		for (const item of items) {
			const opt = activeDocument.createElement('option');
			opt.value = item.id;
			opt.textContent = item['name' as keyof T] as unknown as string || 'Unnamed';
			select.appendChild(opt);
		}
		if (savedValue === '' || validIds.has(savedValue)) {
			select.value = savedValue;
		} else if (items.length > 0) {
			select.value = items[0]!.id;
		}
	}
}
