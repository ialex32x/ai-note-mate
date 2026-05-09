import { setIcon } from 'obsidian';
import { t } from '../../i18n';
import type { BubbleContext } from './bubble-context';

const SPEAK_ICON_NAME = 'volume-2' as const;
const STOP_ICON_NAME = 'square' as const;

/**
 * Encapsulates Web Speech (TTS) behaviour for assistant bubbles.
 *
 * The controller owns a small amount of mutable state that is shared
 * across the various TTS surfaces:
 *
 *  - `selectedVoiceURI` — user's preferred voice, persisted for the
 *    lifetime of the owning {@link BubbleRenderer}. Re-used across every
 *    bubble's speak button so the choice sticks across messages.
 *  - `speakingBtn` / `currentUtterance` — tracks the button that is
 *    currently "lit up" so we can reset it when speech ends, errors,
 *    or is cancelled from elsewhere (e.g. when the host view unloads).
 *
 * Because this state is non-trivial (not a pure function of inputs) the
 * controller is modelled as a class rather than the stateless helpers
 * used by the other bubble sub-modules.
 *
 * The controller does not subclass `Component`; it instead uses
 * {@link BubbleContext.register} to hook into the owning renderer's
 * lifecycle for dropdown cleanup.
 */
export class SpeechController {
    private readonly ctx: BubbleContext;
    private selectedVoiceURI: string | null = null;
    private speakingBtn: HTMLButtonElement | null = null;
    private currentUtterance: SpeechSynthesisUtterance | null = null;

    constructor(ctx: BubbleContext) {
        this.ctx = ctx;
    }

    /**
     * True when the current runtime exposes the Web Speech API. Callers
     * should check this before asking the controller to mount a speak
     * button — the controller will silently no-op on `onSpeak` otherwise,
     * but there's no point rendering the UI if TTS is unavailable.
     */
    static isSupported(): boolean {
        return 'speechSynthesis' in window;
    }

    /**
     * Render the speak button plus its voice-picker dropdown inside an
     * assistant action bar.
     *
     * The voice dropdown is lazily created on first open and lives in the
     * renderer's floating layer (a positioned child of `dropdownHost`) to
     * escape bubble overflow/stacking contexts. While open, the host
     * bubble gets an `--actions-pinned` modifier so the action bar remains
     * visible even when the pointer hovers the dropdown itself (which
     * lies outside the bubble and would otherwise end the `:hover` state
     * and fade the ▾ button out — making it look like the dropdown "can
     * no longer be opened" after selecting an item).
     */
    renderSpeakButtonGroup(actions: HTMLElement, content: string): void {
        const speakGroup = actions.createEl('span', { cls: 'session-bubble__speak-group' });

        const speakBtn = speakGroup.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn session-bubble__speak-btn',
            attr: { 'aria-label': t('view.speakMessage') },
        });
        setIcon(speakBtn, SPEAK_ICON_NAME);
        speakBtn.addEventListener('click', () => this.onSpeak(speakBtn, content));

        const voicePickerBtn = speakGroup.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn session-bubble__voice-picker-btn',
            attr: { 'aria-label': t('view.selectVoice') },
        });
        setIcon(voicePickerBtn, 'chevron-down');

        // Lazily created on first open; torn down on close to avoid
        // leaking detached dropdowns into the host element across bubble
        // re-renders.
        let voiceDropdown: HTMLElement | null = null;
        let outsideClickHandler: ((ev: MouseEvent) => void) | null = null;
        let voicesChangedHandler: (() => void) | null = null;

        // Walk up to the enclosing bubble so we can pin the action bar
        // while the dropdown is open (see doc-comment above).
        const findBubble = (): HTMLElement | null => actions.closest('.session-bubble');

        const populateVoiceDropdown = (): boolean => {
            if (!voiceDropdown) return false;
            voiceDropdown.empty();
            const voices = speechSynthesis.getVoices();
            if (voices.length === 0) {
                voiceDropdown.createEl('div', {
                    cls: 'session-dropdown-item session-bubble__voice-item',
                    text: 'Loading voices…',
                });
                return false;
            }
            const sorted = [...voices].sort((a, b) => {
                if (a.localService !== b.localService) return a.localService ? 1 : -1;
                return a.lang.localeCompare(b.lang);
            });
            for (const v of sorted) {
                const item = voiceDropdown.createEl('div', { cls: 'session-dropdown-item session-bubble__voice-item' });
                const checkSpan = item.createEl('span', { cls: 'session-bubble__voice-item-check' });
                item.createEl('span', {
                    cls: 'session-bubble__voice-item-label',
                    text: v.localService ? `${v.name} (${v.lang})` : `${v.name} (${v.lang}) ★`,
                });
                if (this.selectedVoiceURI === v.voiceURI) {
                    item.addClasses(['session-dropdown-item--active', 'session-bubble__voice-item--active']);
                    setIcon(checkSpan, 'check');
                }
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.selectedVoiceURI = v.voiceURI;
                    closeVoiceDropdown();
                });
            }
            return true;
        };

        const closeVoiceDropdown = () => {
            if (voicesChangedHandler) {
                speechSynthesis.removeEventListener('voiceschanged', voicesChangedHandler);
                voicesChangedHandler = null;
            }
            if (outsideClickHandler) {
                document.removeEventListener('click', outsideClickHandler);
                outsideClickHandler = null;
            }
            if (voiceDropdown) {
                voiceDropdown.remove();
                voiceDropdown = null;
            }
            findBubble()?.removeClass('session-bubble--actions-pinned');
        };

        const openVoiceDropdown = () => {
            // Fresh element each open — keeps the floating layer clean
            // and avoids stale state accumulating across bubble
            // re-renders. Mounted on the renderer's floating layer (a
            // positioned child of `dropdownHost`) so absolute coordinates
            // resolve against a known containing block, immune to
            // ancestor transform/contain quirks that would hijack
            // `position: fixed`.
            const layer = this.ctx.getFloatingLayer();
            voiceDropdown = layer.createEl('div', {
                cls: 'session-dropdown-menu session-dropdown-menu--anchored session-bubble__voice-dropdown',
            });

            const voicesReady = populateVoiceDropdown();
            if (!voicesReady) {
                voicesChangedHandler = () => {
                    if (populateVoiceDropdown() && voicesChangedHandler) {
                        speechSynthesis.removeEventListener('voiceschanged', voicesChangedHandler);
                        voicesChangedHandler = null;
                    }
                };
                speechSynthesis.addEventListener('voiceschanged', voicesChangedHandler);
            }

            // Convert the button's viewport rect into coordinates
            // relative to the floating layer (our positioned ancestor)
            // so the absolute popup lands in the right place regardless
            // of ancestor scrolling or transforms.
            const btnRect = voicePickerBtn.getBoundingClientRect();
            const layerRect = layer.getBoundingClientRect();
            voiceDropdown.style.left = `${btnRect.left - layerRect.left}px`;
            voiceDropdown.style.right = '';
            // Position the popup above the button: its `bottom` (in
            // layer space) sits 4px above the button's top edge.
            voiceDropdown.style.bottom = `${layerRect.bottom - btnRect.top + 4}px`;
            voiceDropdown.addClass('session-dropdown-menu--open');
            findBubble()?.addClass('session-bubble--actions-pinned');

            requestAnimationFrame(() => {
                if (!voiceDropdown) return;
                // Edge-clamp using viewport coords (the user-visible
                // window), then translate the corrected x back into
                // layer space.
                const rect = voiceDropdown.getBoundingClientRect();
                if (rect.right > window.innerWidth) {
                    const clampedViewportLeft = window.innerWidth - rect.width - 8;
                    voiceDropdown.style.left = `${clampedViewportLeft - layerRect.left}px`;
                }
            });

            outsideClickHandler = (ev: MouseEvent) => {
                const target = ev.target as Node;
                if (!speakGroup.contains(target) && !(voiceDropdown && voiceDropdown.contains(target))) {
                    closeVoiceDropdown();
                }
            };
            document.addEventListener('click', outsideClickHandler);
        };

        voicePickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (voiceDropdown) {
                closeVoiceDropdown();
            } else {
                openVoiceDropdown();
            }
        });

        // Ensure cleanup if the owning renderer unloads while a dropdown
        // is open.
        this.ctx.register(() => closeVoiceDropdown());
    }

    /**
     * Cancel any in-flight speech and reset the "speaking" button.
     * Safe to call even when TTS isn't supported or nothing is playing.
     */
    cancelSpeech(): void {
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        this.resetSpeakButton();
    }

    // ── Internal helpers ────────────────────────────────────────────────

    private onSpeak(btn: HTMLButtonElement, content: string): void {
        if (!('speechSynthesis' in window)) return;

        if (this.speakingBtn === btn && speechSynthesis.speaking) {
            speechSynthesis.cancel();
            this.resetSpeakButton();
            return;
        }

        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }

        const plainText = this.stripMarkdownForSpeech(content);

        const utterance = new SpeechSynthesisUtterance(plainText);
        this.currentUtterance = utterance;

        // Detect content language so the TTS engine picks the right
        // phonetics. Without this, Chinese text read by an English voice
        // produces garbled output and vice-versa.
        utterance.lang = this.detectLanguage(plainText);

        if (this.selectedVoiceURI) {
            const voice = speechSynthesis.getVoices().find(v => v.voiceURI === this.selectedVoiceURI);
            if (voice) utterance.voice = voice;
        }

        utterance.onend = () => this.resetSpeakButton();
        utterance.onerror = () => this.resetSpeakButton();

        btn.empty();
        setIcon(btn, STOP_ICON_NAME);
        btn.classList.add('session-bubble__action-btn--speaking');
        this.speakingBtn = btn;

        speechSynthesis.speak(utterance);
    }

    private resetSpeakButton(): void {
        if (this.speakingBtn) {
            this.speakingBtn.empty();
            setIcon(this.speakingBtn, SPEAK_ICON_NAME);
            this.speakingBtn.classList.remove('session-bubble__action-btn--speaking');
        }
        this.speakingBtn = null;
        this.currentUtterance = null;
    }

    /**
     * Strip markdown formatting from content to produce clean speech
     * text. Keeps the speech engine from pronouncing backticks, asterisks,
     * table pipes, and so on.
     */
    private stripMarkdownForSpeech(content: string): string {
        return content
            // Remove HTML comments (e.g. <!--suggestions ...-->)
            .replace(/<!--[\s\S]*?-->/g, '')
            // Remove HTML tags
            .replace(/<[^>]+>/g, '')
            // Remove fenced code blocks
            .replace(/```[\s\S]*?```/g, ' code block ')
            // Remove inline code
            .replace(/`([^`]+)`/g, '$1')
            // Remove bold
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            // Remove italic
            .replace(/\*([^*]+)\*/g, '$1')
            // Remove images (keep alt text)
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
            // Remove links (keep link text)
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove headings markers
            .replace(/^#{1,6}\s+/gm, '')
            // Remove horizontal rules
            .replace(/^[-*_]{3,}\s*$/gm, '')
            // Remove blockquote markers
            .replace(/^>\s?/gm, '')
            // Remove unordered list markers
            .replace(/^[-*+]\s+/gm, '')
            // Remove ordered list markers
            .replace(/^\d+\.\s+/gm, '')
            // Remove table formatting
            .replace(/^\|?.+\|.*$/gm, (line) => {
                return line.replace(/[|]/g, ' ').replace(/[-:]{3,}/g, '');
            })
            // Remove LaTeX math
            .replace(/\$\$[\s\S]*?\$\$/g, ' math expression ')
            .replace(/\$([^$]+)\$/g, '$1')
            // Collapse multiple blank lines into a pause
            .replace(/\n{2,}/g, '. ')
            // Replace remaining newlines with space
            .replace(/\n/g, ' ')
            // Collapse multiple spaces
            .replace(/ {2,}/g, ' ')
            .trim();
    }

    /**
     * Detect the language of the given text.
     * Returns a BCP 47 language tag suitable for
     * `SpeechSynthesisUtterance.lang`.
     *
     * Uses a simple heuristic: if CJK characters dominate, tag as
     * Chinese; if Japanese kana are present, tag as Japanese; if Hangul
     * is present, tag as Korean; otherwise default to the user's locale.
     */
    private detectLanguage(text: string): string {
        const sample = text.slice(0, 500);
        let cjkCount = 0;
        let hiraganaKatakanaCount = 0;
        let hangulCount = 0;

        for (const ch of sample) {
            const code = ch.codePointAt(0)!;
            // CJK Unified Ideographs (common to Chinese & Japanese)
            if ((code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0xF900 && code <= 0xFAFF)) {
                cjkCount++;
            }
            // Hiragana & Katakana (Japanese)
            if ((code >= 0x3040 && code <= 0x309F) ||
                (code >= 0x30A0 && code <= 0x30FF)) {
                hiraganaKatakanaCount++;
            }
            // Hangul (Korean)
            if ((code >= 0xAC00 && code <= 0xD7AF) ||
                (code >= 0x1100 && code <= 0x11FF) ||
                (code >= 0x3130 && code <= 0x318F)) {
                hangulCount++;
            }
        }

        if (hangulCount > 0 && hangulCount >= cjkCount) return 'ko';
        if (hiraganaKatakanaCount > 0) return 'ja';
        if (cjkCount > 0) return 'zh-CN';

        // Default: use the Obsidian locale if available, otherwise 'en'
        const locale = window.localStorage.getItem('language') || 'en';
        return locale;
    }
}
