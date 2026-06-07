/**
 * Compact number formatter: 12345 -> "12.3K", 1_200_000 -> "1.2M".
 */
export function formatCompact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

/**
 * Compact byte formatter.
 * `0` -> "0 B", `4096` -> "4.0 KB", `1_572_864` -> "1.5 MB".
 */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
