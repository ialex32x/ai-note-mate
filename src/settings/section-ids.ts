/**
 * Centralized constants for settings section anchor IDs.
 *
 * These IDs serve two purposes:
 * 1. The `titleKey` of each {@link SettingsSection} — used by the settings tab
 *    host for i18n section titles and as the anchor target for deep-linking.
 * 2. The `sectionId` parameter passed to {@link openPluginSettings} by tips,
 *    toolbar gear buttons, and other deep-link entry points.
 *
 * Keeping them in one place avoids drift between the section definitions and
 * the various consumers that deep-link into them.
 */

/** Anchor id of the Profile (Text Generation) section. */
export const PROFILE_SECTION_ID = 'settings.profileSection';

/** Anchor id of the Embedding section. */
export const EMBEDDING_SECTION_ID = 'settings.embeddingSection';

/** Anchor id of the Image Generation section. */
export const IMAGE_GEN_SECTION_ID = 'settings.imageGenSection';

/** Anchor id of the Tools (MCP) section. */
export const TOOLS_SECTION_ID = 'settings.toolsSection';
