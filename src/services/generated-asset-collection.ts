/**
 * A single generated asset record.
 *
 * Persisted as a top-level session field (`toolCallAssets`) alongside
 * `messages`, `agentTokenBreakdown`, etc. — NOT nested inside individual
 * ChatMessage objects.
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
 *  2. **Cache recovery** — on cold-load, `setAssets` restores from the
 *     persisted top-level `toolCallAssets` session field.
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
	 * Replace the entire collection with a pre-built array (cold-load
	 * path). Called once from
	 * {@link SessionView.hydrateRuntimeFromDisk} via
	 * {@link SessionRuntime.restoreAssets}.
	 */
	setAssets(assets: GeneratedAsset[]): void {
		this._assets = [...assets];
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
