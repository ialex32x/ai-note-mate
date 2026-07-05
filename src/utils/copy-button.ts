import { setIcon, setTooltip } from 'obsidian';
import { copyToClipboard } from './clipboard';

/**
 * Create a copy button with standard flash-feedback behaviour:
 *  1. Click → copy text to clipboard (no Notice, icon feedback only)
 *  2. Icon swaps to `check` on success
 *  3. After 1.5 s the icon reverts to `copy`
 *
 * The button is created using `document.createElement` so it is detached
 * and can be appended to any parent by the caller.
 *
 * @param label  Accessible label for the button (aria-label + tooltip).
 * @param getText Callback that returns the text to copy when clicked.
 * @param cssClass Optional CSS class to add to the button.
 */
export function createCopyButton(
    label: string,
    getText: () => string,
    cssClass?: string,
): HTMLButtonElement {
    const btn = createEl('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    if (cssClass) {
        for (const cls of cssClass.split(/\s+/).filter(Boolean)) {
            btn.classList.add(cls);
        }
    }
    setIcon(btn, 'copy');
    setTooltip(btn, label);

    const handleCopy = async (): Promise<void> => {
        const ok = await copyToClipboard(getText(), { showNotice: false });
        if (!ok) return;
        setIcon(btn, 'check');
        window.setTimeout(() => setIcon(btn, 'copy'), 1500);
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        void handleCopy();
    });

    return btn;
}
