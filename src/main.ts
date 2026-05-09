import { Plugin, WorkspaceLeaf, TAbstractFile, MarkdownView, Editor, MarkdownFileInfo } from 'obsidian';
import { DEFAULT_SETTINGS, NoteAssistantPluginSettings, NoteAssistantSettingTab, createDefaultEmbeddingConfig, createDefaultImageGenConfig } from "./settings";
import { SessionView } from 'views/session-view';
import { resolveLocale, setLocale, t } from './i18n';
import { MCPManager } from './services/mcp/mcp-manager';
import { SkillManager, createVaultFsAdapter } from './skills/skill-manager';
import { initGlobalEmbedder, disposeGlobalEmbedder } from './services/embedder';
import { PluginPaths } from './plugin-paths';
import { EditHistoryStore } from './edit-history/edit-history-store';
import { EditHistoryView } from './edit-history/edit-history-view';
import { registerRewriteSelection, type AISubmenuItem } from './edit-history/rewrite-selection';

export default class NoteAssistantPlugin extends Plugin {
	settings!: NoteAssistantPluginSettings;
	mcpManager!: MCPManager;
	skillManager!: SkillManager;
	paths!: PluginPaths;
	editHistory!: EditHistoryStore;

	private readonly _settingsListeners: Array<() => void> = [];

	/** Register a callback invoked after every `saveSettings()`. */
	onSettingsChange(cb: () => void) {
		this._settingsListeners.push(cb);
	}

	/** Remove a previously registered settings-change callback. */
	offSettingsChange(cb: () => void) {
		const idx = this._settingsListeners.indexOf(cb);
		if (idx !== -1) this._settingsListeners.splice(idx, 1);
	}

	private emitSettingsChange() {
		for (const cb of this._settingsListeners) cb();
	}

	async onload() {
		await this.loadSettings();

		// Initialize i18n before registering any UI strings
		setLocale(resolveLocale());

		this.paths = new PluginPaths(this);
		this.mcpManager = new MCPManager(this);
		this.skillManager = new SkillManager(createVaultFsAdapter(this.app.vault));

		// Initialize the process-wide embedding cache.
		// Lives under the plugin's `cache/` directory — rebuildable derived data,
		// kept separate from user-owned `sessions/` content.
		const cacheDir = this.paths.cache();
		if (!(await this.app.vault.adapter.exists(cacheDir))) {
			await this.app.vault.adapter.mkdir(cacheDir);
		}
		await initGlobalEmbedder({
			adapter: this.app.vault.adapter,
			cacheFilePath: `${cacheDir}/embedder-cache.json`,
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new NoteAssistantSettingTab(this.app, this));

		this.registerView(SessionView.VIEW_TYPE, (leaf) => new SessionView(leaf, this));

		// AI Edit History: store + view + editor menu/commands.
		// Persisted under cache/ since the data is rebuildable derived state
		// (we never want to mix it with user-owned sessions/).
		this.editHistory = new EditHistoryStore(this.app, {
			persistPath: `${this.paths.cache()}/edit-history.json`,
		});
		await this.editHistory.load();
		this.registerView(
			EditHistoryView.VIEW_TYPE,
			(leaf) => new EditHistoryView(leaf, this, this.editHistory),
		);
		// "Send to AI Session" lives inside the same "AI" submenu as the
		// rewrite actions (expand/shorten/polish) so all AI-related editor
		// entries share a single parent. Unlike rewrites, this entry also
		// works without a selection — in that case it inserts only a file
		// reference + cursor coordinates.
		const sendToSessionItem: AISubmenuItem = {
			title: t('view.sendToSession'),
			icon: 'send',
			isAvailable: (_editor, info) => {
				return !!(info as { file?: { path?: string } } | undefined)?.file?.path;
			},
			onClick: (editor, info) => {
				void this.sendEditorContextToSession(editor, info);
			},
		};
		// "Explain" turns the current selection into a ready-made prompt and
		// either sends it directly or — when the AI is mid-turn — drops it
		// into the input for the user to send manually. Selection is required;
		// without one there is nothing meaningful to explain.
		const explainSelectionItem: AISubmenuItem = {
			title: t('view.explainSelection'),
			icon: 'help-circle',
			isAvailable: (editor, info) => {
				const sel = editor.getSelection();
				if (!sel || !sel.trim()) return false;
				return !!(info as { file?: { path?: string } } | undefined)?.file?.path;
			},
			onClick: (editor, info) => {
				void this.explainEditorSelection(editor, info);
			},
		};
		registerRewriteSelection(
			this,
			this.editHistory,
			() => this.revealEditHistoryView(),
			[sendToSessionItem, explainSelectionItem],
		);
		this.addCommand({
			id: 'open-ai-edit-history',
			name: t('editHistory.openView'),
			callback: () => { void this.revealEditHistoryView(); },
		});

		// Register file context menu handler for "Send to AI Session"
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TAbstractFile)) return;

				menu.addItem((item) => {
					item
						.setTitle(t('view.sendToSession'))
						.setIcon('send')
						.setSection('action')
						.onClick(() => {
							this.sendFileToSession(file);
						});
				});
			})
		);

		this.app.workspace.onLayoutReady(() => this.createSessionView(false));
	}

	onunload() {
		void this.mcpManager?.closeAll();
		void disposeGlobalEmbedder();
		this.editHistory?.dispose();
	}

	private async createSessionView(activate: boolean) {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(SessionView.VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0]!;
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: SessionView.VIEW_TYPE, active: activate });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (activate) {
			workspace.revealLeaf(leaf);
		}
		await this.mcpManager.initialize();
		await this.reloadSkills();
	}

	/**
	 * Ensure the AI Edit History view is open and revealed in the right sidebar.
	 * Called both from the explicit command and after an editor rewrite is
	 * triggered, so the user immediately sees the running task.
	 */
	private async revealEditHistoryView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(EditHistoryView.VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: EditHistoryView.VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<NoteAssistantPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});

		// Migrate legacy profile fields. Older versions stored a single
		// `supportsVision: boolean`; we now use a `modalities` array so users
		// can independently enable image / audio / video / pdf inputs.
		// Convert once on load and drop the legacy field — it is no longer
		// read anywhere in the codebase.
		for (const profile of this.settings.profiles) {
			const p = profile as unknown as Record<string, unknown>;
			if (!Array.isArray(p.modalities)) {
				const legacyVision = p.supportsVision;
				p.modalities = legacyVision === false ? [] : ['image'];
			}
			if ('supportsVision' in p) {
				delete p.supportsVision;
			}
		}

		// Ensure activeProfileId points to a valid profile
		if (!this.settings.profiles.find(p => p.id === this.settings.activeProfileId)) {
			if (this.settings.profiles.length > 0) {
				this.settings.activeProfileId = this.settings.profiles[0]!.id;
			}
		}

		// Ensure at least one embedding config exists (cannot delete the last one)
		if (this.settings.embeddingConfigs.length === 0) {
			const defaultEmbedding = createDefaultEmbeddingConfig();
			this.settings.embeddingConfigs.push(defaultEmbedding);
			this.settings.activeEmbeddingId = defaultEmbedding.id;
		} else if (!this.settings.embeddingConfigs.find(c => c.id === this.settings.activeEmbeddingId)) {
			// Ensure activeEmbeddingId points to a valid config
			this.settings.activeEmbeddingId = this.settings.embeddingConfigs[0]!.id;
		}

		// Ensure at least one image gen config exists (cannot delete the last one)
		if (this.settings.imageGenConfigs.length === 0) {
			const defaultImageGen = createDefaultImageGenConfig();
			this.settings.imageGenConfigs.push(defaultImageGen);
			this.settings.activeImageGenId = defaultImageGen.id;
		} else if (!this.settings.imageGenConfigs.find(c => c.id === this.settings.activeImageGenId)) {
			// Ensure activeImageGenId points to a valid config
			this.settings.activeImageGenId = this.settings.imageGenConfigs[0]!.id;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.emitSettingsChange();
	}

	/**
	 * Reloads skills from all configured search paths.
	 * Call this when skillSearchPaths setting changes.
	 */
	async reloadSkills(): Promise<void> {
		const paths = this.settings.skillSearchPaths.filter(p => p.trim() !== '');
		if (paths.length === 0) {
			this.skillManager.clearSkills();
			return;
		}

		await this.skillManager.discoverSkills({ skillDirs: paths });
		// console.log(`Loaded ${this.skillManager.getSkills().length} skills from ${paths.length} directories`);
	}

	/**
	 * Send a file or folder reference to the AI session.
	 * Opens the session view if not visible and inserts the file reference.
	 */
	private async sendFileToSession(file: TAbstractFile): Promise<void> {
		// Activate the session view
		await this.createSessionView(true);

		// Get the session view and insert file reference
		const leaves = this.app.workspace.getLeavesOfType(SessionView.VIEW_TYPE);
		if (leaves.length > 0) {
			const leaf = leaves[0]!;
			const view = leaf.view as SessionView;
			if (view && view.cmInput) {
				view.cmInput.insertFileRef(file);
				view.cmInput.focus();
			}
		}
	}

	/**
	 * Send the active editor's context (file reference + cursor position or
	 * selection range) to the AI session input at its current cursor position.
	 *
	 * Only the file reference and cursor coordinates are inserted — the
	 * selected text itself is intentionally NOT included; downstream
	 * file-ref expansion / tools can fetch the actual content from the
	 * referenced file when needed, which keeps the input compact.
	 *
	 * Format produced by `formatEditorContextSnippet` (line/column numbers
	 * are 1-based to match what users see in editors):
	 * - Without selection:
	 *     [[path]] (Ln <l>, Col <c>)
	 * - With a selection, three common shapes collapse the column info because
	 *   it carries no extra information:
	 *     • end of line A → start of next line B (i.e. selecting just the
	 *       newline between them)              → (Ln <B>)
	 *     • start of line A → end of same line A (the whole line)
	 *                                          → (Ln <A>)
	 *     • start of line A → end of line B (whole-line span across lines)
	 *                                          → (Ln <A> - Ln <B>)
	 * - Any other selection falls back to the full form:
	 *     [[path]] (Ln <l1>, Col <c1> - Ln <l2>, Col <c2>)
	 *
	 * A trailing space is appended so the user can keep typing immediately.
	 */
	private async sendEditorContextToSession(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): Promise<void> {
		const ctx = this.formatEditorContextSnippet(editor, info);
		if (!ctx) return;

		// Activate the session view, then drop the snippet at the input cursor.
		await this.createSessionView(true);
		const view = this.getActiveSessionView();
		if (!view || !view.cmInput) return;

		view.cmInput.insertText(`${ctx.snippet} `);
		view.cmInput.focus();
	}

	/**
	 * Build an "explain" prompt from the active editor's selection and send
	 * it to the AI session — or, when the AI is mid-turn (cannot accept a
	 * new prompt right now), drop the prompt into the input for the user to
	 * send manually once the current turn finishes.
	 *
	 * Selection is required (the menu entry's `isAvailable` already enforces
	 * this; we re-check defensively here in case future call sites bypass
	 * the menu wiring).
	 *
	 * Prompt shape (English, hard-coded — this is content for the LLM, not
	 * UI copy, and the wikilink + range syntax mirrors `Send to AI Session`):
	 *     Please explain the text in [[path]] (Ln A - Ln B)
	 */
	private async explainEditorSelection(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): Promise<void> {
		const sel = editor.getSelection();
		if (!sel || !sel.trim()) return;

		const ctx = this.formatEditorContextSnippet(editor, info);
		if (!ctx) return;

		const prompt = `Please explain the text in ${ctx.snippet}`;

		// Activate the session view so the user immediately sees the
		// outcome (sent message OR pre-filled draft).
		await this.createSessionView(true);
		const view = this.getActiveSessionView();
		if (!view) return;

		view.submitOrFillPrompt(prompt);
	}

	/** Resolve the (first) live SessionView leaf, or null if none. */
	private getActiveSessionView(): SessionView | null {
		const leaves = this.app.workspace.getLeavesOfType(SessionView.VIEW_TYPE);
		if (leaves.length === 0) return null;
		const view = leaves[0]!.view;
		return view instanceof SessionView ? view : null;
	}

	/**
	 * Build a `[[file]] (range)` snippet describing the editor's current
	 * cursor / selection. Returns `null` if no file path can be resolved
	 * (e.g. unsaved buffer with no associated TFile). See the long comment
	 * on `sendEditorContextToSession` for the exact format rules; this
	 * helper exists so multiple entry points (Send to AI Session, Explain)
	 * can share one source of truth for the formatting.
	 */
	private formatEditorContextSnippet(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): { filePath: string; snippet: string } | null {
		const filePath = (info as { file?: { path?: string } } | undefined)?.file?.path
			?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
		if (!filePath) return null;

		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const hasSelection = from.line !== to.line || from.ch !== to.ch;

		// 1-based line numbers for display.
		const lnA = from.line + 1;
		const lnB = to.line + 1;
		// Length of the line where each anchor sits, used to detect "end of line".
		const lenFromLine = editor.getLine(from.line).length;
		const lenToLine = editor.getLine(to.line).length;

		let rangeDesc: string;
		if (!hasSelection) {
			rangeDesc = `Ln ${lnA}, Col ${from.ch + 1}`;
		} else if (
			// end-of-A → start-of-B, B is the line right after A
			to.line === from.line + 1 && from.ch === lenFromLine && to.ch === 0
		) {
			rangeDesc = `Ln ${lnB}`;
		} else if (
			// whole single line: start-of-A → end-of-A
			from.line === to.line && from.ch === 0 && to.ch === lenToLine
		) {
			rangeDesc = `Ln ${lnA}`;
		} else if (
			// whole multi-line span: start-of-A → end-of-B
			from.line < to.line && from.ch === 0 && to.ch === lenToLine
		) {
			rangeDesc = `Ln ${lnA} - Ln ${lnB}`;
		} else {
			rangeDesc = `Ln ${lnA}, Col ${from.ch + 1} - Ln ${lnB}, Col ${to.ch + 1}`;
		}

		return { filePath, snippet: `[[${filePath}]] (${rangeDesc})` };
	}

}