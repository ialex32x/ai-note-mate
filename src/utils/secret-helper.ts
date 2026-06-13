import { App } from "obsidian";

/**
 * Resolve a stored secret by its reference key.
 *
 * Background: API keys entered through this plugin's settings UI are
 * written via Obsidian's `SecretComponent`, which transparently stores
 * the plaintext in {@link App.secretStorage} and persists only a short
 * reference key on the in-memory config object (e.g. `profile.apiKey`).
 * Everywhere outside the settings UI must therefore round-trip through
 * `secretStorage.getSecret(ref)` to recover the actual secret.
 *
 * Returns `""` when:
 *  - The reference is empty / unset (user has not configured the field).
 *  - The reference does not match anything in secret storage (the secret
 *    was deleted, or this is a stale reference from an older settings
 *    snapshot). Callers should treat empty exactly like "not configured"
 *    and surface a UX-level "API key required" notice rather than
 *    forwarding the empty string to an SDK call — almost every upstream
 *    rejects empty keys with a confusing 401.
 *
 * Never falls back to returning the reference itself: the reference is
 * a UUID-shaped opaque token, not a usable API key, and forwarding it
 * to an SDK would produce a misleading auth error instead of a clear
 * "key missing" signal.
 */
export function resolveSecret(app: App, ref: string): string {
    if (!ref) return "";
    return app.secretStorage.getSecret(ref) ?? "";
}
