import { en } from './locales/en';
import { zhCN } from './locales/zh-cn';
import { zhTW } from './locales/zh-tw';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { getLanguage, moment } from 'obsidian';

export type Locale = 'en' | 'zh-cn' | 'zh-tw' | 'ja' | 'ko';

const localeMap: Record<Locale, Record<string, string>> = { en, 'zh-cn': zhCN, 'zh-tw': zhTW, ja, ko };

let currentLocale: Locale = 'en';
let current: Record<string, string> = en;

/**
 * Resolve the effective locale from a user setting.
 * `setting` may be `'auto'` or a locale code.
 *
 * Auto-detect priority (first non-empty wins):
 *   1. `getLanguage()` — Obsidian's own UI language setting, the
 *      canonical source of truth (available since Obsidian 1.8.7;
 *      our `minAppVersion` is well above that). This honours the
 *      user's explicit choice in **Settings → General → Language**
 *      regardless of OS / browser locale.
 *   2. `moment.locale()` — Obsidian normally syncs moment's locale to
 *      the UI language, so this is usually identical to #1; kept as a
 *      fallback in case `getLanguage()` ever returns empty.
 *   3. `navigator.language` — last-resort browser locale.
 *   4. `'en'` — hard default when everything else is empty.
 *
 * Note on Chinese codes: Obsidian uses bare `zh` for Simplified
 * Chinese (not `zh-CN`); the mapping below treats `zh` and `zh-cn` /
 * `zh-hans` interchangeably so we route correctly regardless of which
 * source reports the language.
 */
export function resolveLocale(prefered?: string): Locale {
	if (typeof prefered === 'string') {
		if (prefered in localeMap) return prefered as Locale;
	}
	// Auto-detect — guarded so a runtime that doesn't expose
	// `getLanguage` (older Obsidian, or a test environment whose mock
	// happens to omit it) degrades silently to the moment / navigator
	// chain rather than throwing during plugin load.
	let obsidianLang = '';
	try {
		obsidianLang = getLanguage() || '';
	} catch {
		/* fall through to moment / navigator */
	}
	const nav = obsidianLang || moment.locale() || navigator.language || 'en';

	// Map common variants (e.g. zh-Hans → zh-cn, zh-Hant → zh-tw,
	// bare `zh` → zh-cn as per Obsidian's translation catalogue).
	const lower = nav.toLowerCase();
	if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-hans')) return 'zh-cn';
	if (lower.startsWith('zh-tw') || lower.startsWith('zh-hant')) return 'zh-tw';
	if (lower.startsWith('ja')) return 'ja';
	if (lower.startsWith('ko')) return 'ko';
	return 'en';
}

/** Set the active locale. Call after plugin settings are loaded. */
export function setLocale(locale: Locale): void {
	currentLocale = locale in localeMap ? locale : 'en';
	current = localeMap[currentLocale];
}

/**
 * Get the currently active locale code.
 *
 * Use cases beyond display: building data that needs to be aware of
 * which language the user reads (e.g. composing BM25 candidate text
 * that mixes the user's locale + English trigger keywords so the
 * ranker matches cross-language queries without changing what the
 * LLM sees).
 */
export function getLocale(): Locale {
	return currentLocale;
}

/** Get a translated string, with optional `{var}` substitution. */
export function t(key: string, vars?: Record<string, string | number>): string {
	let str = current[key] ?? en[key] ?? key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			// IMPORTANT: pass replacement as a callback. `String.prototype.replace`
			// with a string replacement processes `$&`, `$$`, `$n`, etc. as special
			// sequences, which corrupts variable values containing literal `$`
			// (e.g. LaTeX math snippets). The function form returns its value
			// verbatim, so `$` characters survive untouched.
			const replacement = String(v);
			str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => replacement);
		}
	}
	return str;
}

/**
 * Look up a translation key in a SPECIFIC locale bundle, with no
 * cross-bundle fallback.
 *
 * Behaviour differences vs. {@link t}:
 *   - Targets the bundle named by `locale`, not the active one.
 *   - When the key is missing in that bundle, returns the key itself
 *     verbatim (no fallback to `en`). Callers can detect a missing
 *     entry with a single `result === key` check.
 *
 * Intended for data assembly that needs to mix multiple languages
 * deterministically (e.g. building BM25 trigger text that concatenates
 * the active locale's keywords with the English ones so mixed
 * "搜索 markdown" queries hit both signals). The no-fallback semantics
 * matter here: if we silently fell back to `en`, the caller couldn't
 * tell whether they appended the same English string twice.
 */
export function tIn(locale: Locale, key: string, vars?: Record<string, string | number>): string {
	const bundle = localeMap[locale] ?? en;
	let str = bundle[key] ?? key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			const replacement = String(v);
			str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => replacement);
		}
	}
	return str;
}
