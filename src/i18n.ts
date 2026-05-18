import { en } from './locales/en';
import { zhCN } from './locales/zh-cn';
import { zhTW } from './locales/zh-tw';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { moment } from 'obsidian';

export type Locale = 'en' | 'zh-cn' | 'zh-tw' | 'ja' | 'ko';

const localeMap: Record<Locale, Record<string, string>> = { en, 'zh-cn': zhCN, 'zh-tw': zhTW, ja, ko };

let current: Record<string, string> = en;

/**
 * Resolve the effective locale from a user setting.
 * `setting` may be `'auto'` or a locale code.
 */
export function resolveLocale(prefered?: string): Locale {
	if (typeof prefered === 'string') {
		if (prefered in localeMap) return prefered as Locale;
	}
	// Auto-detect
	const nav = moment.locale() || navigator.language || 'en';

	// Map common variants (e.g. zh-Hans → zh-cn, zh-Hant → zh-tw)
	const lower = nav.toLowerCase();
	if (lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower === 'zh') return 'zh-cn';
	if (lower.startsWith('zh-tw') || lower.startsWith('zh-hant')) return 'zh-tw';
	if (lower.startsWith('ja')) return 'ja';
	if (lower.startsWith('ko')) return 'ko';
	return 'en';
}

/** Set the active locale. Call after plugin settings are loaded. */
export function setLocale(locale: Locale): void {
	current = localeMap[locale] ?? en;
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
