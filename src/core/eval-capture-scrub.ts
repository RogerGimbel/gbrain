export function scrubEvalText(input: string, maxLength = 240): string {
  let out = input;
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[secret]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[secret]');
  out = out.replace(/\b(token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[secret]');
  out = out.replace(/\/Users\/[^/\s]+/g, '/Users/[user]');
  if (out.length > maxLength) return `${out.slice(0, Math.max(0, maxLength - 1))}…`;
  return out;
}

export function scrubEvalCaptureValue(value: unknown, maxStringLength = 240): unknown {
  if (typeof value === 'string') return scrubEvalText(value, maxStringLength);
  if (Array.isArray(value)) return value.map(v => scrubEvalCaptureValue(v, maxStringLength));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, scrubEvalCaptureValue(val, maxStringLength)]),
    );
  }
  return value;
}
