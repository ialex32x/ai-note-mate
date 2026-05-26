import { App, PluginSettingTab } from "obsidian";
import NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import { createSettingsSection, setAdvancedSettingsVisible } from "../components/settings-components";
import { SectionAnchorNav } from "../components/settings-anchor-nav";
import {
	CustomizeSettingsSection,
	EmbeddingSettingsSection,
	GlobalSettingsSection,
	ImageGenSettingsSection,
	MemorySettingsSection,
	ProfileSettingsSection,
	SectionContext,
	SettingsSection,
	SkillSettingsSection,
	ToolsSettingsSection,
} from "../components/settings-sections";

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
		};

		// Order here defines the display order of sections in the tab
		this.sections = [
			new GlobalSettingsSection(ctx),
			new ProfileSettingsSection(ctx),
			new EmbeddingSettingsSection(ctx),
			new ImageGenSettingsSection(ctx),
			new ToolsSettingsSection(ctx),
			new SkillSettingsSection(ctx),
			new MemorySettingsSection(ctx),
			new CustomizeSettingsSection(ctx),
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
	 * Keeps scroll position, hover state, and focus on unrelated sections
	 * intact.
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
		body.empty();
		setAdvancedSettingsVisible(this.plugin.settings.showAdvanced);
		section.render(body);
		if (headerActions && section.renderHeaderActions) {
			headerActions.empty();
			section.renderHeaderActions(headerActions);
		}
	}
}
