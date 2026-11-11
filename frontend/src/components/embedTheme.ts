/** Colours an admin picks for an embed: light (default), dark, or follow the visitor's device. */
export type EmbedTheme = "light" | "dark" | "auto";

/** The wrapper class that applies a theme's colours (see globals.css). Light needs none. */
export const themeClass = (t?: EmbedTheme) => (t === "dark" ? "embed-theme-dark" : t === "auto" ? "embed-theme-auto" : "");
