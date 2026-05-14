import { setIcon } from 'obsidian';
import type { DropdownItem, DropdownSection } from './types';

/**
 * Unified dropdown manager for session view.
 * Handles all dropdown lifecycle: open, close, outside-click, positioning.
 */
export class DropdownManager {
    private activePopup: { wrapper: HTMLElement; close: () => void } | null = null;
    private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
    private outsideClickDoc: Document | null = null;
    /** Defers outside-click so the opening interaction cannot close the menu. */
    private outsideClickAttachTimer: number | null = null;

    /**
     * Close the currently active popup
     */
    closeActive(): void {
        if (this.outsideClickAttachTimer !== null) {
            window.clearTimeout(this.outsideClickAttachTimer);
            this.outsideClickAttachTimer = null;
        }
        if (this.activePopup) {
            this.activePopup.close();
            this.activePopup = null;
        }
        if (this.outsideClickHandler) {
            (this.outsideClickDoc ?? activeDocument).removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
            this.outsideClickDoc = null;
        }
    }

    /**
     * Check if a specific wrapper has an active popup
     */
    isActive(wrapper: HTMLElement): boolean {
        return this.activePopup?.wrapper === wrapper;
    }

    /**
     * Register a dropdown toggle with unified behavior
     */
    registerToggle(config: {
        wrapper: HTMLElement;
        button: HTMLElement;
        dropdown: HTMLElement;
        onOpen?: () => void;
        /**
         * Runs after the dropdown's `--open` class is applied and this
         * toggle is registered as the active popup, so code that checks
         * {@link DropdownManager.isActive} or measures visible layout
         * (e.g. checkpoint fixed positioning) runs in a consistent state.
         * Outside-click handling is attached on the next macrotask so the
         * opening pointer/click cannot immediately close the menu.
         */
        onAfterOpen?: () => void;
        onClose?: () => void;
    }): void {
        const { wrapper, button, dropdown, onOpen, onAfterOpen, onClose } = config;

        const handleToggle = (e: Event) => {
            e.stopPropagation();
            
            if (this.isActive(wrapper)) {
                this.closeActive();
                return;
            }
            
            this.closeActive();
            onOpen?.();
            
            dropdown.addClass(this.getOpenClass(dropdown));

            const close = () => {
                dropdown.removeClass(this.getOpenClass(dropdown));
                onClose?.();
                if (this.outsideClickHandler) {
                    (this.outsideClickDoc ?? activeDocument).removeEventListener('click', this.outsideClickHandler);
                    this.outsideClickHandler = null;
                    this.outsideClickDoc = null;
                }
            };
            this.activePopup = { wrapper, close };

            onAfterOpen?.();

            const doc = activeDocument;
            const handler = (ev: MouseEvent) => {
                if (!wrapper.contains(ev.target as Node)) {
                    this.closeActive();
                }
            };
            if (this.outsideClickAttachTimer !== null) {
                window.clearTimeout(this.outsideClickAttachTimer);
                this.outsideClickAttachTimer = null;
            }
            this.outsideClickAttachTimer = window.setTimeout(() => {
                this.outsideClickAttachTimer = null;
                if (!this.activePopup || this.activePopup.wrapper !== wrapper) {
                    return;
                }
                this.outsideClickHandler = handler;
                this.outsideClickDoc = doc;
                doc.addEventListener('click', handler);
            }, 0);
        };

        button.addEventListener('click', handleToggle);
    }

    /**
     * Get the open class name for a dropdown element
     */
    private getOpenClass(dropdown: HTMLElement): string {
        const baseClass = dropdown.className.split(' ')[0];
        return `${baseClass}--open`;
    }

    /**
     * Create a dropdown button with icon and text
     */
    static createButton(config: {
        parent: HTMLElement;
        cls: string;
        ariaLabel: string;
        icon?: string;
        text?: string;
        showArrow?: boolean;
    }): { button: HTMLButtonElement; textEl: HTMLElement } {
        const { parent, cls, ariaLabel, icon, text, showArrow = true } = config;
        
        const button = parent.createEl('button', {
            cls,
            attr: { type: 'button', 'aria-label': ariaLabel },
        });

        let textEl: HTMLElement;
        
        if (icon) {
            const iconEl = button.createEl('span', { cls: `${cls}-icon` });
            setIcon(iconEl, icon);
            textEl = button.createEl('span', { cls: `${cls}-text` });
        } else {
            textEl = button.createEl('span', { cls: `${cls}-text` });
        }

        if (text) {
            textEl.setText(text);
        }

        if (showArrow) {
            const arrow = button.createEl('span', { cls: `${cls}-arrow` });
            setIcon(arrow, 'chevron-up');
        }

        return { button, textEl };
    }

    /**
     * Create a dropdown item with optional check icon
     */
    static createItem(config: {
        parent: HTMLElement;
        item: DropdownItem | DropdownSection;
        onSelect?: () => void;
        itemCls?: string;
    }): HTMLElement | null {
        const { parent, item, onSelect, itemCls = 'session-dropdown-item' } = config;

        // Handle section headers
        if ('type' in item && item.type === 'header') {
            const header = parent.createEl('div', {
                cls: `${itemCls.replace('__item', '__section-header')}`,
            });
            header.createEl('span', {
                cls: `${itemCls.replace('__item', '__section-header-text')}`,
                text: item.label,
            });
            return null;
        }

        // Handle regular items
        const dropdownItem = item as DropdownItem;
        
        if (dropdownItem.disabled) {
            const el = parent.createEl('div', {
                cls: `${itemCls} ${itemCls}--disabled`,
            });
            el.createEl('span', { text: dropdownItem.label });
            return el;
        }

        const el = parent.createEl('div', { cls: itemCls });
        
        // Check icon for active state
        const checkIcon = el.createEl('span', { cls: `${itemCls}-check` });
        if (dropdownItem.isActive) {
            el.addClass(`${itemCls}--active`);
            setIcon(checkIcon, 'check');
        }

        el.createEl('span', { text: dropdownItem.label });

        if (onSelect) {
            el.addEventListener('click', onSelect);
        }

        return el;
    }

    /**
     * Update active state for dropdown items
     */
    static updateActiveState(
        items: NodeListOf<HTMLElement>,
        activeItem: HTMLElement,
        itemCls: string
    ): void {
        items.forEach(el => {
            const isActive = el === activeItem;
            el.toggleClass(`${itemCls}--active`, isActive);
            const iconEl = el.querySelector(`.${itemCls}-check`) as HTMLElement;
            if (iconEl) {
                if (isActive) {
                    setIcon(iconEl, 'check');
                } else {
                    iconEl.empty();
                }
            }
        });
    }
}
