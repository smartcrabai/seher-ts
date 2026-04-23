import type { ScheduleRule } from "../types.ts";

function parseRange(s: string): [number, number] | null {
	const idx = s.indexOf("-");
	if (idx < 0) return null;
	const start = Number(s.slice(0, idx));
	const end = Number(s.slice(idx + 1));
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	return [start, end];
}

function weekdayInRanges(
	weekday: number,
	ranges: string[] | undefined,
): boolean {
	if (!ranges) return true;
	return ranges.some((wd) => {
		const parsed = parseRange(wd);
		if (!parsed) return false;
		const [ws, we] = parsed;
		return weekday >= ws && weekday <= we;
	});
}

function scheduleMatchesAt(
	weekdays: string[] | undefined,
	hours: string[] | undefined,
	now: Date,
): boolean {
	const currentHour = now.getHours();
	const currentWeekday = now.getDay();

	if (hours) {
		return hours.some((rangeStr) => {
			const parsed = parseRange(rangeStr);
			if (!parsed) return false;
			const [start, end] = parsed;
			if (currentHour >= start && currentHour < end) {
				return weekdayInRanges(currentWeekday, weekdays);
			}
			if (end > 24) {
				const shifted = currentHour + 24;
				if (shifted >= start && shifted < end) {
					const prevWeekday = (currentWeekday + 6) % 7;
					return weekdayInRanges(prevWeekday, weekdays);
				}
			}
			return false;
		});
	}
	return weekdayInRanges(currentWeekday, weekdays);
}

export function isScheduleActive(rule: ScheduleRule, now: Date): boolean {
	return scheduleMatchesAt(rule.weekdays, rule.hours, now);
}
