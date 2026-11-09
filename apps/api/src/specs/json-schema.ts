/**
 * A small JSON Schema subset for service input and output (plan D4): object, array, string, number,
 * integer, boolean, with type, description, properties, required, additionalProperties (false only),
 * items, enum, maxLength, maxItems, minimum, maximum. Any other keyword is refused when a spec is saved,
 * so validation never meets a keyword it would silently ignore.
 */
export type Schema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: (string | number)[];
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

const KEYS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems', 'minimum', 'maximum']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const MAX_DEPTH = 6;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** null when `s` is a schema of the subset, else the JSON path of the first problem. */
export function schemaProblem(s: unknown, path = '$', depth = 0): string | null {
  if (depth > MAX_DEPTH || !isObj(s)) return path;
  for (const k of Object.keys(s)) if (!KEYS.has(k)) return `${path}.${k}`;
  if (typeof s.type !== 'string' || !TYPES.has(s.type)) return `${path}.type`;
  if (s.description !== undefined && typeof s.description !== 'string') return `${path}.description`;
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) return `${path}.additionalProperties`;
  for (const k of ['maxLength', 'maxItems'] as const) if (s[k] !== undefined && !nat(s[k])) return `${path}.${k}`;
  for (const k of ['minimum', 'maximum'] as const) if (s[k] !== undefined && typeof s[k] !== 'number') return `${path}.${k}`;
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || !s.enum.every((e) => typeof e === 'string' || typeof e === 'number'))) return `${path}.enum`;
  if (s.type === 'object') {
    if (s.properties !== undefined) {
      if (!isObj(s.properties)) return `${path}.properties`;
      for (const [k, v] of Object.entries(s.properties)) {
        const p = schemaProblem(v, `${path}.properties.${k}`, depth + 1);
        if (p) return p;
      }
    }
    if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((r) => typeof r === 'string' && isObj(s.properties) && Object.hasOwn(s.properties, r)))) return `${path}.required`;
  } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
    return `${path}.properties`;
  }
  if (s.type === 'array') {
    if (s.items === undefined) return `${path}.items`;
    const p = schemaProblem(s.items, `${path}.items`, depth + 1);
    if (p) return p;
  } else if (s.items !== undefined) {
    return `${path}.items`;
  }
  return null;
}

/** null when `v` conforms to `s`, else the JSON path of the first mismatch. */
export function validate(s: Schema, v: unknown, path = '$'): string | null {
  switch (s.type) {
    case 'string':
      if (typeof v !== 'string' || (s.maxLength !== undefined && v.length > s.maxLength)) return path;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return path;
      break;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return path;
      if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) return path;
      break;
    case 'array': {
      if (!Array.isArray(v) || (s.maxItems !== undefined && v.length > s.maxItems)) return path;
      for (let i = 0; i < v.length; i++) {
        const p = validate(s.items!, v[i], `${path}[${i}]`);
        if (p) return p;
      }
      break;
    }
    case 'object': {
      if (!isObj(v)) return path;
      const props = s.properties ?? {};
      for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) return `${path}.${r}`;
      for (const [k, val] of Object.entries(v)) {
        const ps = Object.hasOwn(props, k) ? props[k] : undefined;
        if (!ps) {
          if (s.additionalProperties === false) return `${path}.${k}`;
          continue;
        }
        const p = validate(ps, val, `${path}.${k}`);
        if (p) return p;
      }
      break;
    }
    default:
      return path;
  }
  if (s.enum && !s.enum.includes(v as string | number)) return path;
  return null;
}
