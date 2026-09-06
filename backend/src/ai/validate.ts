// Minimal hand validators for structured AI output (spec §27). No schema lib.

export class AiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiValidationError';
  }
}

/** Pull the first balanced JSON object/array out of a model response. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to a bracket scan */
  }
  const start = trimmed.search(/[[{]/);
  if (start === -1) throw new AiValidationError('no JSON found in response');
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch (e) {
          throw new AiValidationError(`malformed JSON: ${(e as Error).message}`);
        }
      }
    }
  }
  throw new AiValidationError('unbalanced JSON in response');
}

export function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AiValidationError('expected an object');
  return v as Record<string, unknown>;
}

export function asString(v: unknown, field: string, max = 8000): string {
  if (typeof v !== 'string') throw new AiValidationError(`${field}: expected string`);
  return v.slice(0, max);
}

export function asStringArray(v: unknown, field: string, maxItems = 20): string[] {
  if (!Array.isArray(v)) throw new AiValidationError(`${field}: expected array`);
  return v.slice(0, maxItems).map((x, i) => asString(x, `${field}[${i}]`));
}
