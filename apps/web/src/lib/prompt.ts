/** The prompt cap the draft flow applies to `?prompt=` and its own box (the homepage ask caps at the same 500). */
export const PROMPT_MAX = 500;

export const clampPrompt = (text: string): string => text.slice(0, PROMPT_MAX);
