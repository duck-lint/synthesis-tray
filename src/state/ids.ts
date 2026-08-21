export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
