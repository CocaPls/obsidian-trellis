/** Pure tag-value suggestion and legacy bootstrap rules. */

export type ValueRuleKind = "alternating" | "sequence" | "date" | "timestamp";

/** User-facing tag-value suggestion rule. It never rewrites existing tags. */
export interface TagValueRule {
	kind: ValueRuleKind;
	firstLevel?: "alphabet" | "number";
	letterCase?: "upper" | "lower";
	numberWidth?: "auto" | 1 | 2 | 3 | 4;
	start?: 0 | 1;
	dateFormat?: "YYYYMMDD" | "YYYY-MM-DD" | "YYMMDD";
	timestampPrecision?: "minute" | "second" | "millisecond";
	timezone?: "local" | "utc";
}

/** Legacy value-rule preset ids retained for settings and automation compatibility. */
export type SchemeId = "spark" | "zettel" | "date" | "seq";

export const SCHEME_IDS: SchemeId[] = ["spark", "zettel", "date", "seq"];

/** Convert a legacy scheme id into the current tag-definition value rule. */
export function valueRuleFromLegacyScheme(scheme?: SchemeId): TagValueRule | undefined {
	if (!scheme) return undefined;
	if (scheme === "spark") {
		return {
			kind: "alternating",
			firstLevel: "alphabet",
			letterCase: "upper",
			numberWidth: 2,
		};
	}
	if (scheme === "seq") return { kind: "sequence", start: 1, numberWidth: "auto" };
	if (scheme === "date") return { kind: "date", dateFormat: "YYYYMMDD" };
	return { kind: "timestamp", timestampPrecision: "second", timezone: "local" };
}

/** Compatibility projection for old Bootstrap helpers that still accept SchemeId. */
export function legacySchemeFromValueRule(rule?: TagValueRule): SchemeId | undefined {
	if (!rule) return undefined;
	if (rule.kind === "alternating") return "spark";
	if (rule.kind === "sequence") return "seq";
	if (rule.kind === "date") return "date";
	return "zettel";
}

/** Whether a string is a reversible sequence of two or more ASCII letter/digit runs. */
export function looksLikeTagkey(value: string): boolean {
	const segments = value.match(/[A-Za-z]+|[0-9]+/g);
	return segments !== null && segments.length >= 2 && segments.join("") === value;
}

function nextLetterRun(value: string): string {
	const upper = value === value.toUpperCase();
	const characters = value.toUpperCase().split("");
	let index = characters.length - 1;
	while (index >= 0) {
		if (characters[index] !== "Z") {
			characters[index] = String.fromCharCode(characters[index].charCodeAt(0) + 1);
			break;
		}
		characters[index] = "A";
		index--;
	}
	if (index < 0) characters.unshift("A");
	const result = characters.join("");
	return upper ? result : result.toLowerCase();
}

function nextNumberRun(siblings: string[]): string {
	let max = 0;
	let width = 1;
	for (const sibling of siblings) {
		const value = parseInt(sibling, 10);
		if (value > max) max = value;
		if (sibling.length > width) width = sibling.length;
	}
	return String(max + 1).padStart(width, "0");
}

function formattedNumber(value: number, width: TagValueRule["numberWidth"]): string {
	return width === undefined || width === "auto"
		? String(value)
		: String(value).padStart(width, "0");
}

function nextConfiguredNumber(
	siblings: string[],
	start: number,
	width: TagValueRule["numberWidth"]
): string | null {
	if (siblings.some((segment) => !/^[0-9]+$/.test(segment))) return null;
	const max = siblings.reduce((value, segment) => Math.max(value, Number(segment)), start - 1);
	const automaticWidth = siblings.reduce(
		(value, segment) => Math.max(value, segment.length),
		1
	);
	return width === undefined || width === "auto"
		? String(max + 1).padStart(automaticWidth, "0")
		: formattedNumber(max + 1, width);
}

function dateParts(now: Date, timezone: TagValueRule["timezone"]) {
	const utc = timezone === "utc";
	return {
		year: utc ? now.getUTCFullYear() : now.getFullYear(),
		month: (utc ? now.getUTCMonth() : now.getMonth()) + 1,
		day: utc ? now.getUTCDate() : now.getDate(),
		hour: utc ? now.getUTCHours() : now.getHours(),
		minute: utc ? now.getUTCMinutes() : now.getMinutes(),
		second: utc ? now.getUTCSeconds() : now.getSeconds(),
		millisecond: utc ? now.getUTCMilliseconds() : now.getMilliseconds(),
	};
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** Suggest the next value under a managed parent without writing anything. */
export function suggestTagValue(
	rule: TagValueRule,
	parentDepth: number,
	siblings: string[],
	now: Date
): string | null {
	if (rule.kind === "alternating") {
		const first = rule.firstLevel ?? "alphabet";
		const alphabetLevel = parentDepth % 2 === 0 ? first === "alphabet" : first !== "alphabet";
		if (alphabetLevel) {
			if (siblings.some((segment) => !/^[A-Za-z]+$/.test(segment))) return null;
			const lower = rule.letterCase === "lower";
			if (siblings.length === 0) return lower ? "a" : "A";
			const ordered = [...siblings].sort((left, right) =>
				left.length !== right.length
					? left.length - right.length
					: left.toUpperCase().localeCompare(right.toUpperCase())
			);
			const next = nextLetterRun(ordered[ordered.length - 1]);
			return lower ? next.toLowerCase() : next.toUpperCase();
		}
		return nextConfiguredNumber(siblings, 1, rule.numberWidth ?? "auto");
	}
	if (rule.kind === "sequence") {
		return nextConfiguredNumber(siblings, rule.start ?? 1, rule.numberWidth ?? "auto");
	}
	const parts = dateParts(now, rule.kind === "timestamp" ? rule.timezone : "local");
	const year = String(parts.year);
	const date = `${year}${pad2(parts.month)}${pad2(parts.day)}`;
	if (rule.kind === "date") {
		if (rule.dateFormat === "YYYY-MM-DD") {
			return `${year}-${pad2(parts.month)}-${pad2(parts.day)}`;
		}
		if (rule.dateFormat === "YYMMDD") return date.slice(2);
		return date;
	}
	let timestamp = `${date}${pad2(parts.hour)}${pad2(parts.minute)}`;
	if (rule.timestampPrecision !== "minute") timestamp += pad2(parts.second);
	if (rule.timestampPrecision === "millisecond") {
		timestamp += String(parts.millisecond).padStart(3, "0");
	}
	return timestamp;
}

/** Legacy preset suggestion retained for compatible callers and bootstrap. */
export function suggestSegment(
	scheme: SchemeId,
	parentSegment: string,
	siblings: string[],
	now: Date
): string {
	if (scheme === "zettel") {
		return (
			`${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
			`${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
		);
	}
	if (scheme === "date") {
		return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
	}
	if (scheme === "seq") {
		const numbers = siblings.filter((value) => /^[0-9]+$/.test(value));
		return numbers.length ? nextNumberRun(numbers) : "1";
	}
	const digitSiblings = siblings.filter((value) => /^[0-9]+$/.test(value));
	const letterSiblings = siblings.filter((value) => /^[A-Za-z]+$/.test(value));
	if (siblings.length > 0) {
		if (digitSiblings.length === siblings.length) return nextNumberRun(digitSiblings);
		if (letterSiblings.length === siblings.length) {
			const max = [...letterSiblings].sort((left, right) => {
				if (left.length !== right.length) return left.length - right.length;
				return left.toUpperCase() < right.toUpperCase() ? -1 : 1;
			})[letterSiblings.length - 1];
			return nextLetterRun(max);
		}
		return digitSiblings.length ? nextNumberRun(digitSiblings) : "01";
	}
	if (/^[A-Za-z]+$/.test(parentSegment)) return "01";
	if (/^[0-9]+$/.test(parentSegment)) return "A";
	return "01";
}

/** Parse one flattened legacy value according to a configured preset. */
export function schemeSegments(scheme: SchemeId, tagkey: string): string[] | null {
	if (scheme === "zettel") return /^[0-9]{12,14}$/.test(tagkey) ? [tagkey] : null;
	if (scheme === "date") return /^[0-9]{8}$/.test(tagkey) ? [tagkey] : null;
	if (scheme === "seq") return /^[0-9]+$/.test(tagkey) ? [tagkey] : null;
	return looksLikeTagkey(tagkey) ? tagkey.match(/[A-Za-z]+|[0-9]+/g)! : null;
}
