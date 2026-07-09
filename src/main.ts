import { Plugin, WorkspaceLeaf, TAbstractFile, TFile, MarkdownView, Editor, MarkdownFileInfo, Notice, debounce, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, NoteAssistantPluginSettings, NoteAssistantSettingTab, createDefaultEmbeddingConfig, createDefaultImageGenConfig, createDefaultSpeechToTextConfig } from "./settings";
import { SessionView } from 'views/session-view';
import { resolveLocale, setLocale, t } from './i18n';
import { MCPManager } from './services/mcp/mcp-manager';
import { SkillManager, createVaultFsAdapter } from './skills/skill-manager';
import { initGlobalEmbedder, disposeGlobalEmbedder } from './services/embedder';
import { PluginPaths } from './plugin-paths';
import { EditHistoryView } from './edit-history/edit-history-view';
import { VaultEditLogStore } from './edit-history/vault-edit-log-store';
import { registerEditorAISubmenu, type AISubmenuItem } from './edit-history/rewrite-selection';
import { SessionManager } from './session-manager';
import { SessionRuntimePool } from './services/session-runtime';
import { VaultMutator, GlobalFileLockManager, SnapshotManager } from './services/vault';
import { MemoryStore } from './services/memory';
import { CustomMenuService } from './services/custom-menu/custom-menu-service';
import type { CustomMenuItem } from './services/custom-menu/types';
import { replaceMenuVariables } from './services/custom-menu/variable-replacer';
import { parseFrontmatterFromContent } from './utils/frontmatter';
import { setDebugEnabledGetter } from './utils/logger';

export default class NoteAssistantPlugin extends Plugin {
	settings!: NoteAssistantPluginSettings;
	mcpManager!: MCPManager;
	skillManager!: SkillManager;
	paths!: PluginPaths;
	/**
	 * Log of vault file mutations performed by AI tool calls (create /
	 * modify / rename / delete). Metadata-only — no file content. Shown
	 * in the AI Edit History sidebar view.
	 *
	 * Read-side aggregator — entries are written to disk by each
	 * session's own {@link EditLogWriter} instance and added here via
	 * {@link VaultEditLogStore.addEntry}.
	 */
	vaultEditLog!: VaultEditLogStore;
	/**
	 * Plugin-wide session storage. Owned at the plugin level (not per-view)
	 * so multiple SessionView leaves observe the same underlying data and so
	 * the {@link SessionRuntimePool} can keep background runtimes alive
	 * across view detach/reattach without their persistence target shifting.
	 */
	sessionManager!: SessionManager;
	/**
	 * Pool of in-memory chat runtimes ({@link SessionRuntime}), keyed by
	 * sessionId. The pool keeps busy chat instances alive after the
	 * SessionView switches away from them, so an in-progress response is
	 * not aborted just because the user navigated elsewhere.
	 */
	runtimePool!: SessionRuntimePool;
	/**
	 * Central gateway for all AI-driven vault mutations. Every edit tool
	 * funnels through this instead of touching `app.vault.*` + the audit
	 * log directly, so cross-cutting concerns (audit logging today; cross-
	 * session file locking and per-checkpoint snapshotting in subsequent
	 * steps) live in exactly one place.
	 */
	vaultMutator!: VaultMutator;
	/**
	 * Process-wide table of files currently locked by an active
	 * session's pending checkpoint. Cross-session writes against a
	 * locked file are refused by the {@link VaultMutator}; the AI Edit
	 * rewrite path consults this table read-only before starting a
	 * selection rewrite. Runtime-only state — never serialised.
	 */
	fileLockManager!: GlobalFileLockManager;
	/**
	 * On-disk blob store for pre-modification file snapshots. Used by
	 * the per-session {@link CheckpointStore} when a file enters a
	 * pending checkpoint for the first time, so the change can be
	 * rolled back on discard. Runtime-only — startup cleanup wipes the
	 * whole directory.
	 */
	snapshotManager!: SnapshotManager;
	/**
	 * Long-term memory note CRUD. Backs the per-turn system-prompt
	 * prefix (auto recall) and the `memory_store` / `memory_delete`
	 * tools. Single store shared across all sessions so a write from
	 * one chat is immediately visible to the next.
	 */
	memoryStore!: MemoryStore;
	/**
	 * User-customisable right-click / file-menu prompts. Parsed from
	 * the vault note configured at {@link NoteAssistantPluginSettings.customMenuNotePath}.
	 * Items are eagerly cached so synchronous menu-event callbacks can
	 * read them without awaiting.
	 */
	customMenuService!: CustomMenuService;
	/**
	 * Cached content of the AGENT.md file (if configured and exists).
	 * Read eagerly on plugin load and refreshed whenever the path setting
	 * changes. {@link createChatAgent} reads this synchronously so session
	 * creation stays fast. `null` means the file is absent or not configured.
	 */
	agentMdCache: { content: string; mtime: number; path: string } | null = null;

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

	/**
	 * Read AGENT.md from the vault (async) and populate {@link agentMdCache}.
	 * Called on plugin load and whenever the path setting changes.
	 *
	 * Errors are swallowed — a missing or unreadable AGENT.md simply
	 * means the cache stays null and the runtime falls back to the
	 * inline Initial Prompt string.
	 */
	async refreshAgentMd(): Promise<void> {
		try {
			const raw = this.settings.agentMdPath?.trim() ?? '';
			if (!raw) {
				this.agentMdCache = null;
				return;
			}
			const path = normalizePath(raw);
			const af = this.app.vault.getAbstractFileByPath(path);
			if (!(af instanceof TFile)) {
				this.agentMdCache = null;
				return;
			}
			const mtime = af.stat.mtime;
			if (
				this.agentMdCache &&
				this.agentMdCache.path === af.path &&
				this.agentMdCache.mtime === mtime
			) {
				return; // Cache is fresh
			}
			const rawContent = await this.app.vault.cachedRead(af);
			// Strip YAML front matter (between --- delimiters) so that
			// Obsidian metadata like tags/aliases don't pollute the prompt.
			const content = parseFrontmatterFromContent(rawContent).body;
			this.agentMdCache = { content, mtime, path: af.path };
		} catch (err) {
			// A broken AGENT.md should never block anything, but we log
			// the error so filesystem issues (permissions, corruption)
			// don't stay invisible forever.
			console.warn('[NoteMate] Failed to read AGENT.md, cache cleared:', err);
			this.agentMdCache = null;
		}
	}

	async onload() {
		await this.loadSettings();

		// Wire the debug-enabled getter so the centralised logger can
		// gate console.debug / console.info by the user's setting.
		setDebugEnabledGetter(() => this.settings.debugEnabled);

		// Pre-read AGENT.md so createChatAgent can access it synchronously.
		void this.refreshAgentMd();

		// Initialize i18n before registering any UI strings
		setLocale(resolveLocale());

		this.paths = new PluginPaths(this);
		this.mcpManager = new MCPManager(this);
		this.skillManager = new SkillManager(createVaultFsAdapter(this.app.vault));
		// Plugin-wide session storage. Session list is loaded lazily when
		// SessionView opens (or when another caller awaits loadFromCache).
		this.sessionManager = new SessionManager(this.app, this.paths.sessions());
		// Runtime pool needs the session manager for per-id persistence
		// after background turns finish.
		this.runtimePool = new SessionRuntimePool(this, { maxIdle: 3 });

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

		// Read-side aggregator — scans per-session JSONL files at startup
		// and stays in sync via `addEntry()` calls from VaultMutator.
		// The legacy `cache/vault-edit-log.json` is deleted on load
		// (one-shot migration cleanup, removable in a future version).
		this.vaultEditLog = new VaultEditLogStore(this.app, {
			sessionsDir: this.paths.sessions(),
			legacyPersistPath: `${this.paths.cache()}/vault-edit-log.json`,
		});
		void this.vaultEditLog.load();
		// Cross-session file lock table; consulted by VaultMutator before
		// AI-driven vault writes. Pure in-memory state.
		this.fileLockManager = new GlobalFileLockManager();
		// Snapshot blob store for checkpoint rollback. Lives under cache/
		// since the data is runtime-only. The clearAll() call here is the
		// reliable cleanup point: anything left over from a previous
		// session (clean exit or crash) is reaped before the new run can
		// reference it.
		this.snapshotManager = new SnapshotManager(this.app, {
			rootDir: `${this.paths.cache()}/snapshots`,
		});
		void this.snapshotManager.clearAll();
		// VaultMutator is the single gateway every AI edit tool calls into.
		// Constructed AFTER `vaultEditLog` because it reads from
		// `plugin.vaultEditLog` to record audit entries.
		this.vaultMutator = new VaultMutator(this);
		// Memory store is plugin-scoped (one note serves every session).
		// Constructed after settings/app are ready; the store reads the
		// configured path lazily so changes to `memoryNotePath` take
		// effect on the next access without an explicit reload.
		this.memoryStore = new MemoryStore(this);
		// Custom menu service — parses MENU.md into menu items. Cache is
		// kept fresh via vault events so synchronous menu callbacks always
		// read up-to-date data without awaiting.
		this.customMenuService = new CustomMenuService(this);
		void this.customMenuService.refresh();

		// Keep the custom-menu cache fresh via vault events.
		const menuPath = () => this.settings.customMenuNotePath.trim();

		const onMenuFileChanged = (file: TAbstractFile) => {
			if (menuPath() && file.path === menuPath()) {
				void this.customMenuService.refresh();
			}
		};

		// `modify` fires on every keystroke — debounce to avoid
		// excessive re-parsing while the user types. Path check is
		// outside the debounce so a fast switch to another file
		// within the 500 ms window won't silently drop the menu
		// file's own pending refresh.
		const debouncedMenuRefresh = debounce(() => {
			void this.customMenuService.refresh();
		}, 500);

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (menuPath() && file.path === menuPath()) {
				debouncedMenuRefresh();
			}
		}));
		this.registerEvent(this.app.vault.on('create', onMenuFileChanged));
		this.registerEvent(this.app.vault.on('delete', onMenuFileChanged));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			const path = menuPath();
			if (path && (file.path === path || oldPath === path)) {
				void this.customMenuService.refresh();
			}
		}));

		// Keep the AGENT.md cache fresh via vault events, mirroring the
		// custom-menu pattern above. `modify` is debounced per-file to
		// avoid re-reading on every keystroke.
		const agentMdPath = () => (this.settings.agentMdPath ?? '').trim();
		const onAgentMdFileChanged = (file: TAbstractFile) => {
			const path = agentMdPath();
			if (path && file.path === path) {
				void this.refreshAgentMd();
			}
		};
		const debouncedAgentMdRefresh = debounce(() => {
			void this.refreshAgentMd();
		}, 500);
		this.registerEvent(this.app.vault.on('modify', (file) => {
			const path = agentMdPath();
			if (path && file.path === path) {
				debouncedAgentMdRefresh();
			}
		}));
		this.registerEvent(this.app.vault.on('create', onAgentMdFileChanged));
		this.registerEvent(this.app.vault.on('delete', onAgentMdFileChanged));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			const path = agentMdPath();
			if (path && (file.path === path || oldPath === path)) {
				void this.refreshAgentMd();
			}
		}));
		this.registerView(
			EditHistoryView.VIEW_TYPE,
			(leaf) => new EditHistoryView(leaf, this, this.vaultEditLog),
		);
		// "Send to AI Session" lives inside the same "AI" submenu as the
		// MENU.md editor items so all AI-related editor entries share a
		// single parent. Unlike selection-scoped prompts, this entry also
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
		// "Send to New AI Session" mirrors the entry above, but creates a
		// fresh session first. If the current session can't be switched
		// (mid-stream or another switch in flight) the action surfaces a
		// Notice and is a no-op — we never silently replace the active
		// chat under the user's feet.
		const sendToNewSessionItem: AISubmenuItem = {
			title: t('view.sendToNewSession'),
			icon: 'message-square-plus',
			isAvailable: (_editor, info) => {
				return !!(info as { file?: { path?: string } } | undefined)?.file?.path;
			},
			onClick: (editor, info) => {
				void this.sendEditorContextToNewSession(editor, info);
			},
		};
		registerEditorAISubmenu(
			this,
			[sendToSessionItem, sendToNewSessionItem],
			(_editor, info) => {
				// Dynamic items from MENU.md (Editor category). Cache is
				// kept warm by vault events — no await needed.
				const filePath = (info as { file?: { path?: string } } | undefined)?.file?.path;
				const customItems = this.customMenuService.getCachedItemsForTarget(
					'editor-menu',
					filePath,
				);
				if (customItems.length === 0) return [];
				return customItems.map(ci => ({
					title: ci.label,
					icon: ci.icon ?? 'sparkles',
					onClick: (editor: Editor) => {
						void this.executeCustomMenuItem(ci, {
							filePath,
							editor,
						});
					},
				}));
			},
		);

		this.addCommand({
			id: 'open-ai-edit-history',
			name: t('editHistory.openView'),
			callback: () => { void this.revealEditHistoryView(); },
		});

		// Command-palette equivalent of the file-menu "Send to AI Session"
		// entry. Acts on the currently active file (the menu version receives
		// its target from the right-click context, which the palette has no
		// access to). `checkCallback` hides the command when there is no
		// active file so it doesn't show up as a dead entry.
		this.addCommand({
			id: 'send-active-file-to-ai-session',
			name: t('view.sendToSession'),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					void this.sendFileToSession(file);
				}
				return true;
			},
		});

		// Register file context menu handler. Uses a two-level "AI" submenu
		// (mirroring the editor-menu structure built in registerEditorAISubmenu)
		// so file-scoped AI actions stay grouped under one parent entry
		// instead of cluttering the top level of the file menu.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TAbstractFile)) return;

				// Cache is kept warm by vault events — no await needed.
				const customItems = this.customMenuService.getCachedItemsForTarget(
					'file-menu',
					file,
				);

				menu.addItem((item) => {
					item
						.setTitle(t('editHistory.menu.aiSubmenu'))
						.setIcon('sparkles')
						.setSection('action');
					// `setSubmenu()` is exposed at runtime but missing from
					// Obsidian's public typings — narrow it locally, the
					// same pattern is used by registerEditorAISubmenu.
					const sub = (item as unknown as { setSubmenu: () => {
						addItem: (cb: (s: {
							setTitle: (n: string) => unknown;
							setIcon: (n: string) => unknown;
							onClick: (cb: () => void) => unknown;
						}) => void) => unknown;
						addSeparator?: () => unknown;
					} }).setSubmenu();

					sub.addItem((s) => {
						s.setTitle(t('view.sendToSession'));
						s.setIcon('send');
						s.onClick(() => {
							void this.sendFileToSession(file);
						});
					});
					sub.addItem((s) => {
						s.setTitle(t('view.sendToNewSession'));
						s.setIcon('message-square-plus');
						s.onClick(() => {
							void this.sendFileToNewSession(file);
						});
					});

					// Separator between built-in actions and custom items.
					if (customItems.length > 0) {
						sub.addSeparator?.();
					}
					for (const ci of customItems) {
						sub.addItem((s) => {
							s.setTitle(ci.label);
							s.setIcon(ci.icon ?? 'sparkles');
							s.onClick(() => {
								void this.executeCustomMenuItem(ci, { filePath: file.path });
							});
						});
					}
				});
			})
		);

		this.app.workspace.onLayoutReady(() => this.createSessionView(false));
	}

	onunload() {
		// Tear down background runtimes first so any in-flight chat
		// stream is aborted before its dependencies (mcp, embedder) go
		// away under it.
		this.runtimePool?.disposeAll();
		void this.mcpManager?.closeAll();
		void disposeGlobalEmbedder();
		this.vaultEditLog?.dispose();
		// Snapshots are runtime-only — best-effort wipe on unload so the
		// directory doesn't grow between launches in the happy-path
		// case. `onunload` is synchronous, so this is fire-and-forget;
		// the reliable cleanup happens at the NEXT startup via the
		// `clearAll()` call in `onload`.
		void this.snapshotManager?.clearAll().catch(() => { /* swallow */ });
		this._settingsListeners.length = 0;
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
			void workspace.revealLeaf(leaf);
		}
		await this.mcpManager.initialize();
		await this.reloadSkills();
	}

	/**
	 * Ensure the AI Edit History view is open and revealed in the right sidebar.
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
		void workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<NoteAssistantPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});

		// Legacy: the old `memories` array (stored in data.json) has been
		// retired in favour of a vault-note-backed `MemoryStore`. The
		// data is intentionally NOT migrated — users author their own
		// memories in the new note. Strip the stale field so it does not
		// linger in saved data forever.
		const legacy = this.settings as unknown as Record<string, unknown>;
		if ('memories' in legacy) {
			delete legacy.memories;
		}
		if ('followUpSuggestionsAutoSend' in legacy) {
			delete legacy.followUpSuggestionsAutoSend;
		}

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
			// Backfill context-compression tunables introduced after the
			// initial release. `Object.assign(DEFAULT_SETTINGS, saved)` only
			// merges top-level keys, not per-profile fields, so older
			// data.json files would otherwise produce `undefined` here and
			// trip the `typeof === 'number'` checks downstream.
			if (typeof profile.contextCompressionThreshold !== 'number') {
				profile.contextCompressionThreshold = 0;
			}
			if (typeof profile.slidingWindowSize !== 'number') {
				profile.slidingWindowSize = 0;
			}
			if (typeof profile.maxSummariesThreshold !== 'number') {
				profile.maxSummariesThreshold = 0;
			}
		}

		// Custom agents were previously string[] (note paths). Migrate to
		// CustomAgentConfig[] (inline persisted config). If the old format
		// is detected, reset to empty — individual note contents cannot be
		// reliably ported without reading every note on every load.
		if (!Array.isArray(this.settings.agents)) {
			this.settings.agents = [];
		} else if (this.settings.agents.length > 0 && typeof this.settings.agents[0] === 'string') {
			this.settings.agents = [];
		}
		// Ensure every agent object has fields added in later versions.
		for (const agent of this.settings.agents) {
			if (typeof agent.name !== 'string') {
				agent.name = '';
			}
			if (typeof agent.systemPrompt !== 'string') {
				agent.systemPrompt = '';
			}
			if (typeof agent.disabled !== 'boolean') {
				agent.disabled = false;
			}
		}

		// Ensure activeProfileId points to a valid profile
		if (!this.settings.profiles.find(p => p.id === this.settings.activeProfileId)) {
			if (this.settings.profiles.length > 0) {
				this.settings.activeProfileId = this.settings.profiles[0]!.id;
			}
		}

		if (
			this.settings.insightsProfileId
			&& !this.settings.profiles.some(p => p.id === this.settings.insightsProfileId)
		) {
			this.settings.insightsProfileId = '';
		}

		// Ensure at least one embedding config exists (UI needs a tab to show).
		if (this.settings.embeddingConfigs.length === 0) {
			const defaultEmbedding = createDefaultEmbeddingConfig();
			this.settings.embeddingConfigs.push(defaultEmbedding);
		}
		// Validate activeEmbeddingId: if it points to a non-existent config,
		// fall back to empty (None). Empty means embedding is disabled.
		if (this.settings.activeEmbeddingId
			&& !this.settings.embeddingConfigs.find(c => c.id === this.settings.activeEmbeddingId)) {
			this.settings.activeEmbeddingId = '';
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

		// Ensure at least one speech-to-text config exists
		if (this.settings.speechToTextConfigs.length === 0) {
			const defaultStt = createDefaultSpeechToTextConfig();
			this.settings.speechToTextConfigs.push(defaultStt);
			this.settings.activeSpeechToTextId = defaultStt.id;
		} else {
			// Migrate legacy STT fields. Older versions stored a single
			// `model: string` and `baseUrl: string` along with a
			// `'qwen-asr'` apiScheme. We now use a `'DashScope'` scheme
			// with `region` + optional `workspaceId`, and split the model
			// into `shortModel` (inline API) and `longModel` (async file
			// API). Migrate once on load and drop the legacy fields.
			for (const stt of this.settings.speechToTextConfigs) {
				const s = stt as unknown as Record<string, unknown>;
				if (s.apiScheme === 'qwen-asr') {
					s.apiScheme = 'DashScope';
				}
				if (typeof stt.region !== 'string') {
					stt.region = 'cn-beijing';
				}
				if (typeof stt.workspaceId !== 'string') {
					stt.workspaceId = '';
				}
				const legacyModel = typeof s.model === 'string' ? s.model : '';
				if (typeof stt.shortModel !== 'string' || stt.shortModel.length === 0) {
					stt.shortModel = legacyModel || 'qwen3-asr-flash';
				}
				if (typeof stt.longModel !== 'string' || stt.longModel.length === 0) {
					stt.longModel = 'qwen3-asr-flash-filetrans';
				}
				if (typeof stt.secretId !== 'string') {
					stt.secretId = '';
				}
				if (typeof stt.secretKey !== 'string') {
					stt.secretKey = '';
				}
				if (typeof stt.engineModelType !== 'string') {
					stt.engineModelType = '16k_zh';
				}
				if (typeof stt.cosBucket !== 'string') {
					stt.cosBucket = '';
				}
				if (typeof stt.cosRegion !== 'string') {
					stt.cosRegion = '';
				}
				if ('model' in s) delete s.model;
				if ('baseUrl' in s) delete s.baseUrl;
			}
			if (!this.settings.speechToTextConfigs.find(c => c.id === this.settings.activeSpeechToTextId)) {
				this.settings.activeSpeechToTextId = this.settings.speechToTextConfigs[0]!.id;
			}
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
	}

	/**
	 * Send a file or folder reference to the AI session.
	 * Opens the session view if not visible and inserts the file reference.
	 */
	private async sendFileToSession(file: TAbstractFile): Promise<void> {
		// Activate the session view
		await this.createSessionView(true);

		// Get the session view and insert file reference
		const view = this.getActiveSessionView();
		if (!view || !view.cmInput) return;
		if (!view.isReady()) {
			new Notice(t('view.sessionNotReady'));
			return;
		}

		view.cmInput.insertFileRef(file);
		view.cmInput.focus();
	}

	/**
	 * Like {@link sendFileToSession}, but starts a brand-new session before
	 * inserting the file reference. Mirrors {@link sendEditorContextToNewSession}:
	 * if the active session can't be switched right now (mid-stream or another
	 * switch in flight) the SessionView surfaces a Notice and we abort without
	 * touching the existing chat.
	 */
	private async sendFileToNewSession(file: TAbstractFile): Promise<void> {
		await this.createSessionView(true);
		const view = this.getActiveSessionView();
		if (!view || !view.cmInput) return;
		if (!view.isReady()) {
			new Notice(t('view.sessionNotReady'));
			return;
		}

		// Bail out (the SessionView already showed a Notice) when busy —
		// silently falling back to the existing session would contradict
		// the user's "new session" intent.
		const ok = await view.startNewSession();
		if (!ok) return;

		view.cmInput.insertFileRef(file);
		view.cmInput.focus();
	}

	/**
	 * Send the active editor's context (file reference + cursor position or
	 * selection range, plus a short preview of the selected text when
	 * present) to the AI session input at its current cursor position.
	 *
	 * For selections the snippet also carries up to
	 * {@link SELECTION_PREVIEW_CODEPOINT_LIMIT} code points of the selected
	 * text as a markdown blockquote — this saves the model a `read_file`
	 * round-trip for short selections and snapshots the user's intent at
	 * send-time (the file may be edited before the model resolves the
	 * range). Larger selections are truncated with a parenthetical hint and
	 * the model is expected to fall back to `read_file` for the rest.
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
	 * - When a non-whitespace selection exists, the range is followed by
	 *   the selection preview on its own line(s), each line prefixed with
	 *   `> ` (markdown blockquote). Truncated selections end with
	 *   `... (+N chars omitted)` immediately after the quoted body.
	 *
	 * A trailer is appended so the user can keep typing immediately —
	 * a single space for the single-line variant, or a blank line for
	 * snippets that carry a multi-line preview block (otherwise the
	 * next keystroke would extend the final `> ...` line).
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
		if (!view.isReady()) {
			new Notice(t('view.sessionNotReady'));
			return;
		}

		view.cmInput.insertText(`${ctx.snippet}${snippetTrailer(ctx.snippet)}`);
		view.cmInput.focus();
	}

	/**
	 * Like {@link sendEditorContextToSession}, but starts a brand-new
	 * session before dropping the snippet into the input.
	 *
	 * If the current view cannot switch sessions right now (an answer is
	 * streaming, or another switch is already underway), the SessionView
	 * surfaces a Notice and we abort without touching the editor or the
	 * existing chat. This avoids quietly clobbering an in-progress turn
	 * just because the user picked the wrong menu entry.
	 */
	private async sendEditorContextToNewSession(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): Promise<void> {
		const ctx = this.formatEditorContextSnippet(editor, info);
		if (!ctx) return;

		// Ensure the session view exists and is revealed first; otherwise
		// there is no view instance to inspect for switch-eligibility.
		await this.createSessionView(true);
		const view = this.getActiveSessionView();
		if (!view || !view.cmInput) return;
		if (!view.isReady()) {
			new Notice(t('view.sessionNotReady'));
			return;
		}

		// Bail out — with the user-visible Notice already shown by the
		// view — when the active session is busy. We deliberately do NOT
		// fall back to the existing session here: the user's intent was
		// "new session", and silently degrading would be confusing.
		const ok = await view.startNewSession();
		if (!ok) return;

		view.cmInput.insertText(`${ctx.snippet}${snippetTrailer(ctx.snippet)}`);
		view.cmInput.focus();
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
	 * helper exists so the Send to AI Session entry points can share one
	 * source of truth for the formatting.
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

		let snippet = `[[${filePath}]] (${rangeDesc})`;
		if (hasSelection) {
			const preview = buildSelectionPreviewBlock(editor.getSelection());
			if (preview) snippet = `${snippet}\n${preview}`;
		}
		return { filePath, snippet };
	}

	/**
	 * Execute a single custom menu item: replace template variables with
	 * live context, then park the resulting prompt in the session input
	 * via {@link SessionView.fillPromptDraft}. The fill-or-refuse
	 * semantics match other session draft actions — if the input
	 * already contains user text a Notice is surfaced and the action is
	 * refused.
	 */
	private async executeCustomMenuItem(
		item: CustomMenuItem,
		ctx: { filePath?: string; editor?: Editor },
	): Promise<void> {
		const prompt = replaceMenuVariables(item.promptTemplate, {
			filePath: ctx.filePath,
			editor: ctx.editor,
		});

		await this.createSessionView(true);
		const view = this.getActiveSessionView();
		if (!view) return;
		if (!view.isReady()) {
			new Notice(t('view.sessionNotReady'));
			return;
		}

		view.fillPromptDraft(prompt);
	}

}

/**
 * Maximum number of Unicode code points carried inline as a selection
 * preview. Sized intentionally small: the goal is to let the model see a
 * couple of sentences (CJK) or a paragraph fragment (Latin) without
 * having to call `read_file`, while keeping the input area readable and
 * the user-message payload tiny. Anything longer is truncated and the
 * model is expected to fall back to `read_file` for the rest.
 *
 * Counted in code points (`Array.from(str).length`), not UTF-16 code
 * units — `String.prototype.length` and `slice` are unsafe across
 * surrogate pairs (most emoji, some CJK extensions) and can produce
 * lone surrogates when truncated mid-pair.
 */
const SELECTION_PREVIEW_CODEPOINT_LIMIT = 100;

/**
 * Minimum number of (trimmed) Unicode code points required to emit a
 * preview block at all. Single-character selections are almost always
 * either a misclick or a single punctuation mark — the `> x`
 * blockquote line adds visual noise without giving the model anything
 * it couldn't recover from the file ref's line/column range plus one
 * `read_file`. CJK-aware threshold: kept tight at 2 (drop only N≤1) so
 * legitimate 2-char CJK words like "机器" / "你好" still get previewed.
 */
const SELECTION_PREVIEW_MIN_CODEPOINTS = 2;

/**
 * Build a markdown-blockquoted preview of a selected snippet, suitable
 * for inlining into the chat input next to a `[[path]] (range)` file
 * reference. Returns `null` when there is nothing meaningful to show —
 * either an empty / all-whitespace selection, or one whose trimmed
 * length is below {@link SELECTION_PREVIEW_MIN_CODEPOINTS} — so callers
 * can drop the preview line entirely instead of emitting a stray `> `.
 *
 * Truncation operates on Unicode code points to avoid splitting
 * surrogate pairs (most emoji, supplementary CJK). It does NOT split on
 * extended grapheme clusters — a ZWJ-joined emoji like 👨‍👩‍👧‍👦 may be
 * cut in the middle in pathological cases — but the result is still
 * well-formed Unicode (no lone surrogates) and the preview is purely
 * informational, so the loss of cosmetic fidelity is acceptable in
 * exchange for not pulling in `Intl.Segmenter`.
 */
function buildSelectionPreviewBlock(selection: string): string | null {
	// Length gate is measured against the trimmed selection so that, e.g.,
	// `"  AI  "` (6 code units, but only 2 visible characters) is dropped
	// the same as a bare `"AI"`.
	if (Array.from(selection.trim()).length < SELECTION_PREVIEW_MIN_CODEPOINTS) {
		return null;
	}

	const codepoints = Array.from(selection);
	let body: string;
	let suffix = '';
	if (codepoints.length > SELECTION_PREVIEW_CODEPOINT_LIMIT) {
		body = codepoints.slice(0, SELECTION_PREVIEW_CODEPOINT_LIMIT).join('');
		const omitted = codepoints.length - SELECTION_PREVIEW_CODEPOINT_LIMIT;
		suffix = `... (+${omitted} ${omitted === 1 ? 'char' : 'chars'} omitted)`;
	} else {
		body = selection;
	}

	// Drop leading/trailing newlines so the quoted block doesn't open with
	// an empty `> ` line (common when the selection starts at end-of-line)
	// or end with the truncation suffix dangling on its own stray "> " line.
	body = body.replace(/^\n+/, '').replace(/\n+$/, '');
	if (!body) return null;

	const quoted = body.split('\n').map(line => `> ${line}`).join('\n');
	return suffix ? `${quoted}${suffix}` : quoted;
}

/**
 * Choose the whitespace to drop after a context snippet when inserting
 * it into the chat input. A single-line snippet keeps the legacy
 * trailing space so the user can keep typing inline; multi-line snippets
 * (those carrying a quoted selection preview) get a blank line instead,
 * so the user's next keystroke starts fresh below the blockquote
 * instead of being absorbed into the last `> ...` line.
 */
function snippetTrailer(snippet: string): string {
	return snippet.includes('\n') ? '\n\n' : ' ';
}
