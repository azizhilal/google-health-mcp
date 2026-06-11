/**
 * Coaching-oriented MCP tools. These are intentionally higher-level than the
 * raw Google Health endpoints: each one answers a question a coach actually
 * asks ("how recovered am I?", "what's my HRV trend?") and returns compact JSON
 * for Claude to reason over alongside Strava workout data.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleHealthClient } from "./google-health";
import { isoDaysAgo, todayIso } from "./dates";

/**
 * Data type IDs in the Google Health API v4. The daily-aggregated metrics
 * (resting HR, HRV, sleep) are fetched via `reconcile`; the others via
 * `dailyRollUp`. Resting HR and HRV only exist as `daily-` computed types.
 */
const DATA_TYPE = {
  restingHeartRate: "daily-resting-heart-rate",
  heartRateVariability: "daily-heart-rate-variability",
  sleep: "sleep",
  heartRate: "heart-rate",
  activeZoneMinutes: "active-zone-minutes",
  nutrition: "nutrition-log",
  hydration: "hydration-log",
} as const;

/** These tools only read upstream data and reach an external API. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Daily computed types (resting HR, HRV) filter on a flat `date` field
 *  rather than the `interval.civil_start_time` used by interval types. */
const BY_DATE = { timeMember: "date" } as const;

/** Sleep is a session type: it filters on `interval.end_time` (a physical
 *  Timestamp), i.e. each night is bucketed by wake time. Confirmed via the
 *  diagnostics probe — `start_time` and `session_time_interval` are rejected. */
const SLEEP_FILTER = { timeMember: "interval.end_time", physical: true } as const;

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Number of data points in an API response, regardless of which array key
 *  the method uses (`dataPoints` for list/reconcile, `rollupDataPoints` for
 *  dailyRollUp). Returns 0 when neither is present. */
function countItems(resp: unknown): number {
  const obj = resp as Record<string, unknown> | null;
  for (const key of ["dataPoints", "rollupDataPoints"]) {
    const arr = obj?.[key];
    if (Array.isArray(arr)) return arr.length;
  }
  return 0;
}

/** Map a raw Google Health API error to an actionable hint, when we recognise it. */
function hintFor(message: string): string | undefined {
  if (/\b403\b|PERMISSION_DENIED/.test(message))
    return "The token is missing the OAuth scope for this data type. Reconnect the connector and grant the requested permission (e.g. nutrition).";
  if (/INVALID_DATA_POINT_FILTER/.test(message))
    return "The filter field is invalid for this data type — its time member differs (daily types use `date`, sessions like sleep use `interval.end_time`, other intervals use `interval.civil_start_time`).";
  if (/\b401\b|UNAUTHENTICATED/.test(message))
    return "Authentication failed even after a token refresh — the refresh token may be revoked. Reconnect the connector.";
  if (/\b404\b|NOT_FOUND/.test(message))
    return "Data type not found — the data type ID may be wrong or unsupported.";
  return undefined;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintFor(message);
  const text = hint ? `Error: ${message}\n\nHint: ${hint}` : `Error: ${message}`;
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Register all tools on the MCP server. `getClient` defers client construction
 * to call-time so token refresh works against live props.
 */
export function registerTools(
  server: McpServer,
  getClient: () => GoogleHealthClient,
  timeZone: string,
) {
  // The headline tool: one call to decide "should I train today?"
  server.registerTool(
    "get_recovery_snapshot",
    {
      title: "Recovery Snapshot",
      description: "Get last night's recovery signals (sleep, resting heart rate, and HRV) for a single day. Use this to judge training readiness for today. Defaults to the most recent day.",
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day to fetch, YYYY-MM-DD. Defaults to today.") },
      annotations: READ_ONLY,
    },
    async ({ date }) => {
      try {
        const day = date ?? todayIso(timeZone);
        const client = getClient();
        const [sleep, restingHr, hrv] = await Promise.all([
          client.reconcile(DATA_TYPE.sleep, day, day, SLEEP_FILTER),
          client.reconcile(DATA_TYPE.restingHeartRate, day, day, BY_DATE),
          client.reconcile(DATA_TYPE.heartRateVariability, day, day, BY_DATE),
        ]);
        return jsonResult({ date: day, sleep, restingHeartRate: restingHr, hrv });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_hrv_trend",
    {
      title: "HRV Trend",
      description: "Get daily heart-rate-variability (HRV) values over a recent window to assess autonomic recovery trend. Higher/stable HRV generally indicates good recovery.",
      inputSchema: { days: z.number().int().min(1).max(90).default(14).describe("Number of days back from today.") },
      annotations: READ_ONLY,
    },
    async ({ days }) => {
      try {
        return jsonResult(await getClient().reconcile(DATA_TYPE.heartRateVariability, isoDaysAgo(days, timeZone), todayIso(timeZone), BY_DATE));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_resting_hr_trend",
    {
      title: "Resting Heart Rate Trend",
      description: "Get daily resting heart rate over a recent window. A rising resting HR can signal accumulated fatigue, illness, or under-recovery.",
      inputSchema: { days: z.number().int().min(1).max(90).default(14).describe("Number of days back from today.") },
      annotations: READ_ONLY,
    },
    async ({ days }) => {
      try {
        return jsonResult(await getClient().reconcile(DATA_TYPE.restingHeartRate, isoDaysAgo(days, timeZone), todayIso(timeZone), BY_DATE));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_sleep",
    {
      title: "Sleep",
      description: "Get daily sleep summaries (duration and stages) over a date range. Use for sleep-debt and consistency analysis.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        return jsonResult(await getClient().reconcile(DATA_TYPE.sleep, start_date, end_date, SLEEP_FILTER));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_daily_summary",
    {
      title: "Daily Activity Summary",
      description: "Get an activity/load summary for a date range: active-zone-minutes and resting heart rate. Complements Strava workout data with all-day load.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [azm, restingHr] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.activeZoneMinutes, start_date, end_date),
          client.reconcile(DATA_TYPE.restingHeartRate, start_date, end_date, BY_DATE),
        ]);
        return jsonResult({ activeZoneMinutes: azm, restingHeartRate: restingHr });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_nutrition",
    {
      title: "Nutrition & Hydration",
      description: "Get daily nutrition intake (calories and macronutrients) and hydration over a date range. Data originates from apps like MyFitnessPal via Health Connect. Use to assess fuelling relative to training load.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [nutrition, hydration] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.nutrition, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.hydration, start_date, end_date),
        ]);
        return jsonResult({ nutrition, hydration });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Self-check: probe every metric over the last few days and report, per
  // metric, whether it returned data / was empty / errored (with the API's
  // error). Turns "the connector is broken" into a precise map of which
  // data type + method + filter is failing.
  server.registerTool(
    "run_diagnostics",
    {
      title: "Run Diagnostics",
      description: "Probe each Google Health data type over the last few days and report per-metric status (ok / empty / error). Use this to diagnose connection or data-availability problems.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const end = todayIso(timeZone);
      const start = isoDaysAgo(3, timeZone);
      const client = getClient();

      const probes: { metric: string; run: () => Promise<unknown> }[] = [
        { metric: "sleep", run: () => client.reconcile(DATA_TYPE.sleep, start, end, SLEEP_FILTER) },
        { metric: "resting_heart_rate", run: () => client.reconcile(DATA_TYPE.restingHeartRate, start, end, BY_DATE) },
        { metric: "hrv", run: () => client.reconcile(DATA_TYPE.heartRateVariability, start, end, BY_DATE) },
        { metric: "active_zone_minutes", run: () => client.dailyRollUp(DATA_TYPE.activeZoneMinutes, start, end) },
        { metric: "heart_rate", run: () => client.dailyRollUp(DATA_TYPE.heartRate, start, end) },
        { metric: "nutrition", run: () => client.dailyRollUp(DATA_TYPE.nutrition, start, end) },
        { metric: "hydration", run: () => client.dailyRollUp(DATA_TYPE.hydration, start, end) },
      ];

      const results = await Promise.all(
        probes.map(async (p) => {
          try {
            const points = countItems(await p.run());
            return { metric: p.metric, status: points > 0 ? "ok" : "empty", points };
          } catch (err) {
            return {
              metric: p.metric,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      return jsonResult({ window: { start, end }, timeZone, results });
    },
  );
}
