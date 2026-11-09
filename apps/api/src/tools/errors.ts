/** A tool failure the model sees as `tool: <code>`. Codes are fixed words: never user data, never an upstream body. */
export type ToolError = Error & { code: string };
export const toolError = (code: string): ToolError => Object.assign(new Error(`tool: ${code}`), { code });
