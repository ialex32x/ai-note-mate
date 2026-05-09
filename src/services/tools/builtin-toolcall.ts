import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";

/**
 * Create built-in tool collection
 * @param _plugin Plugin instance
 * @returns Array of registered tools
 */
export function createBuiltinTools(_plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        getCurrentDateTime(),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_current_datetime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to get current date and time
 * Returns ISO format datetime string and Chinese lunar calendar date
 */
function getCurrentDateTime(): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "get_current_datetime",
                description:
                    "Get the current date and time information. Returns ISO datetime, " +
                    "Unix timestamp, formatted local time, weekday, and Chinese lunar calendar date. " +
                    "Use this when the user asks about 'now', 'today', 'current time', 'what time is it', " +
                    "'what day is it', or needs temporal context for their query. ",
                parameters: {
                    type: "object",
                    properties: {
                        timezone: {
                            type: "string",
                            description:
                                "Optional timezone string (e.g., 'Asia/Shanghai', 'UTC'). " +
                                "Defaults to the system's local timezone.",
                        },
                    },
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const timezone = args["timezone"] as string | undefined;
            const now = new Date();

            try {
                // Basic time information
                const result: Record<string, unknown> = {
                    iso: now.toISOString(),
                    unix: Math.floor(now.getTime() / 1000),
                    local: now.toLocaleString("zh-CN", {
                        timeZone: timezone || undefined,
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                    }),
                    weekday: now.toLocaleDateString("zh-CN", {
                        timeZone: timezone || undefined,
                        weekday: "long",
                    }),
                    timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                };

                // Try to calculate Chinese lunar calendar date (simplified implementation)
                const lunarDate = getChineseLunarDate(now);
                if (lunarDate) {
                    result["lunar"] = lunarDate;
                }

                return { success: true, type: "object", content: result };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Failed to get datetime: ${msg}` };
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chinese Lunar Calendar Helper (Simplified)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simplified Chinese lunar calendar date calculation
 * Note: This is a simplified implementation and may not be accurate
 */
function getChineseLunarDate(date: Date): string | null {
    try {
        // Calculate using lunar calendar data table
        const lunarInfo = getLunarYearInfo(date.getFullYear());
        if (!lunarInfo) return null;

        const lunarDate = solarToLunar(date, lunarInfo);
        if (!lunarDate) return null;

        const { year, month, day, isLeap } = lunarDate;
        const monthName = getLunarMonthName(month, isLeap);
        const dayName = getLunarDayName(day);

        return `${year}年${monthName}${dayName}`;
    } catch {
        return null;
    }
}

/**
 * Lunar year information
 */
interface LunarYearInfo {
    year: number;
    // Size of each month in the year (1 = big month with 30 days, 0 = small month with 29 days), starting from the first month
    months: number[];
    // Leap month number (0 means no leap month)
    leapMonth: number;
}

/**
 * Get lunar calendar information for a specified year
 * Only contains data from 2020-2030
 */
function getLunarYearInfo(year: number): LunarYearInfo | null {
    // Lunar calendar data table (simplified, only 2020-2030)
    // Data format: [year, 1st month size, 2nd month size, ..., leap month number (0 means no leap month)]
    const lunarData: Array<[number, ...number[]]> = [
        [2020, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 4], // 2020 leap 4th month
        [2021, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2022, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2023, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2], // 2023 leap 2nd month
        [2024, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2025, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 6], // 2025 leap 6th month
        [2026, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2027, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2028, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 5], // 2028 leap 5th month
        [2029, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        [2030, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    ];

    const data = lunarData.find(d => d[0] === year);
    if (!data) return null;

    const months = data.slice(1, 13).map(m => m as number);
    const leapMonth = data[13] as number;

    return { year, months, leapMonth };
}

/**
 * Convert solar date to lunar date
 */
function solarToLunar(date: Date, lunarInfo: LunarYearInfo): { year: number; month: number; day: number; isLeap: boolean } | null {
    const yearStart = new Date(lunarInfo.year, 0, 1);
    const dayOfYear = Math.floor((date.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000));

    let remainingDays = dayOfYear;
    let month = 1;
    let isLeap = false;

    // Calculate lunar month and day
    for (let i = 0; i < 12; i++) {
        const monthDays = lunarInfo.months[i] === 1 ? 30 : 29;

        // Check if there is a leap month
        if (lunarInfo.leapMonth > 0 && i === lunarInfo.leapMonth - 1) {
            // Current month is the one before the leap month, need to handle the leap month
            if (remainingDays < monthDays) {
                month = i + 1;
                break;
            }
            remainingDays -= monthDays;

            // Leap month
            if (remainingDays < monthDays) {
                month = i + 1;
                isLeap = true;
                break;
            }
            remainingDays -= monthDays;
        } else {
            if (remainingDays < monthDays) {
                month = i + 1;
                break;
            }
            remainingDays -= monthDays;
        }
    }

    const day = remainingDays + 1;

    return { year: lunarInfo.year, month, day, isLeap };
}

/**
 * Get lunar month name
 */
function getLunarMonthName(month: number, isLeap: boolean): string {
    const monthNames = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
    const prefix = isLeap ? "闰" : "";
    return prefix + monthNames[month - 1];
}

/**
 * Get lunar day name
 */
function getLunarDayName(day: number): string {
    const dayNames = [
        "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
        "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
    ];
    return dayNames[day - 1] || `${day}日`;
}