/**
 * Lightweight ID generation shared across the plugin.
 *
 * Format: `{timestamp}-{7-char random base36}`, e.g. `1719000000000-abc1234`.
 * Chosen over crypto.randomUUID() for a slightly shorter string and because
 * timestamp prefix naturally orders IDs by creation time in most contexts.
 */
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
