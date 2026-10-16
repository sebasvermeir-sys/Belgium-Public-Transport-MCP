/** Short stable id from text (FNV-1a 32-bit, base36). Used for disruption ids that must not change between calls. */
export function stableId(prefix: string, ...parts: (string | number | undefined)[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.map((p) => String(p ?? "")).join("|")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}:${h.toString(36)}`;
}
