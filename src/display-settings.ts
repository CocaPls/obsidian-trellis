export const DISPLAY_SURFACES = ["explorer", "tabs", "titles", "search", "backlinks", "switcher"] as const;
export type DisplaySurface = typeof DISPLAY_SURFACES[number];
export type DisplaySettings = Record<DisplaySurface, boolean>;

export function normalizeDisplaySettings(value: unknown): DisplaySettings {
	const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return Object.fromEntries(DISPLAY_SURFACES.map(key => [key, input[key] === true])) as DisplaySettings;
}
