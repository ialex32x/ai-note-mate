/**
 * Dropdown item configuration
 */
export interface DropdownItem<T = string> {
    value: T;
    label: string;
    tip?: string;
    isActive?: boolean;
    disabled?: boolean;
}

/**
 * Dropdown section header
 */
export interface DropdownSection {
    type: 'header';
    label: string;
}
