/**
 * A single generated asset record.
 *
 * Stored on {@link ChatMessage.toolCallAssets} (persisted) and aggregated
 * by {@link GeneratedAssetCollection} (per-session runtime view).
 */
export interface GeneratedAsset {
	/** Vault-relative path of the generated file. */
	path: string;
	/** The `toolCallId` of the message whose tool invocation produced this asset. */
	toolCallId: string;
	/** Unix-ms timestamp when the asset was generated. */
	timestamp: number;
}

/**
 * Per-session collection of assets generated during the conversation.
 *
 * Owned by {@link SessionRuntime}.  Two data paths:
 *
 *  1. **Real-time** — the chat factory wires `onAssetGenerated` so every
 *     successful tool call that produces assets pushes into the collection
 *     immediately.
 *  2. **Cache recovery** — on cold-load, `rebuildFromMessages` iterates the
 *     restored {@link ChatMessage} array and collects every
 *     `toolCallAssets` field.
 *
 * The collection emits change notifications so the UI button can
 * show/hide/update its badge count reactively.
 */
export class GeneratedAssetCollection {
	private _assets: GeneratedAsset[] = [];
	private readonly listeners = new Set<() => void>();

	/** Read-only snapshot of all assets recorded so far. */
	get assets(): ReadonlyArray<GeneratedAsset> {
		return this._assets;
	}

	/**
	 * Append assets from a freshly-executed tool call (real-time path).
	 * Each entry is pushed as-is; no dedup is performed.
	 */
	addAssets(incoming: GeneratedAsset[]): void {
		if (incoming.length === 0) return;
		this._assets.push(...incoming);
		this.notify();
	}

	/**
	 * Rebuild the entire collection by iterating every message and
	 * collecting all {@link ChatMessage.toolCallAssets} fields.
	 *
	 * Called once on cold-load from {@link SessionView.hydrateRuntimeFromDisk}.
	 */
	rebuildFromMessages(messages: ReadonlyArray<{ toolCallAssets?: GeneratedAsset[] }>): void {
		const collected: GeneratedAsset[] = [];
		for (const msg of messages) {
			if (msg.toolCallAssets && msg.toolCallAssets.length > 0) {
				collected.push(...msg.toolCallAssets);
			}
		}
		this._assets = collected;
		this.notify();
	}

	/**
	 * Subscribe to change notifications.  Returns a detach function.
	 * The UI uses this to know when to refresh the asset button
	 * visibility / badge count.
	 */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const l of this.listeners) {
			try {
				l();
			} catch (err) {
				console.error('[GeneratedAssetCollection] listener threw:', err);
			}
		}
	}
}
