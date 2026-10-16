const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export class UnknownVariableError extends Error {
  constructor(readonly names: string[]) {
    super(`unknown variable(s): ${names.join(', ')}`)
  }
}

/** Variable names (without dots) referenced as `{{NAME}}` in the given strings. */
export function referencedVariables(...inputs: string[]): string[] {
  const names = new Set<string>()
  for (const input of inputs) {
    for (const m of input.matchAll(VARIABLE_RE)) {
      if (!m[1].includes('.')) names.add(m[1])
    }
  }
  return [...names]
}

/**
 * Replace `{{key}}` placeholders. Unknown keys throw so a typo never silently
 * sends a literal placeholder downstream.
 */
export function renderTemplate(
  input: string,
  values: Record<string, string>,
  escape: (value: string) => string = (v) => v,
): string {
  const missing = new Set<string>()
  const out = input.replace(VARIABLE_RE, (_, key: string) => {
    if (!(key in values)) {
      missing.add(key)
      return ''
    }
    return escape(values[key])
  })
  if (missing.size > 0) throw new UnknownVariableError([...missing])
  return out
}

/** Escape a value for embedding inside a JSON string literal. */
export function jsonStringEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/** Replace every occurrence of the given secrets with `***`. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***')
  }
  return out
}
