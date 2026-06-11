/**
 * Token-lean shaping of API responses before they go to the model. We don't
 * use an allowlist (too easy to drop a value field we didn't anticipate) —
 * instead we strip a denylist of envelope keys that carry no coaching signal:
 * long resource IDs, device/app source descriptors, and record-lifecycle
 * timestamps. Everything else (values, measurement timestamps, sleep stage
 * summaries) is preserved.
 */
const NOISE_KEYS = new Set([
  "name", // users/.../dataPoints/{id} resource path
  "dataSource", // device + application descriptor blob
  "originDataPointId",
  "originDataSource",
  "createTime", // record lifecycle, not measurement time
  "updateTime",
]);

/** Recursively drop envelope/metadata keys, preserving values and timestamps. */
export function pruneEnvelope(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneEnvelope);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (NOISE_KEYS.has(key)) continue;
      out[key] = pruneEnvelope(v);
    }
    return out;
  }
  return value;
}

/** Prune envelope noise and serialize compactly (no pretty-print whitespace). */
export function toLeanJson(data: unknown): string {
  return JSON.stringify(pruneEnvelope(data));
}
