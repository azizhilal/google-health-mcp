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
import { toLeanJson } from "./shape";

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
  steps: "steps",
  distance: "distance",
  totalCalories: "total-calories",
  weight: "weight",
  bodyFat: "body-fat",
  height: "height",
  oxygenSaturation: "daily-oxygen-saturation",
  respiratoryRate: "daily-respiratory-rate",
  respiratoryRateSleepSummary: "respiratory-rate-sleep-summary",
  vo2Max: "daily-vo2-max",
  runVo2Max: "run-vo2-max",
  nutrition: "nutrition-log",
  hydration: "hydration-log",
  // Nightly skin-temperature variation derived during sleep (the "skin temp"
  // metric in the Fitbit app). A daily computed type like resting HR/HRV.
  skinTemperature: "daily-sleep-temperature-derivations",
  coreBodyTemperature: "core-body-temperature",
  bloodGlucose: "blood-glucose",
  heartRateZones: "daily-heart-rate-zones",
  timeInHeartRateZone: "time-in-heart-rate-zone",
  caloriesInHeartRateZone: "calories-in-heart-rate-zone",
  exercise: "exercise",
  floors: "floors",
  activeMinutes: "active-minutes",
  activeEnergyBurned: "active-energy-burned",
  sedentaryPeriod: "sedentary-period",
  swimLengths: "swim-lengths-data",
  altitude: "altitude",
  electrocardiogram: "electrocardiogram",
  irregularRhythm: "irregular-rhythm-notification",
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

/** Measurement (sample) types — height, IRN, respiratory-rate-sleep-summary —
 *  filter on `sample_time.physical_time`, an RFC3339-`Z` Timestamp. */
const BY_SAMPLE_TIME = { timeMember: "sample_time.physical_time", physical: true } as const;

/** ECG records filter on `interval.start_time` as a physical Timestamp
 *  (per the docs' own filter example), unlike other interval types. */
const ECG_FILTER = { timeMember: "interval.start_time", physical: true } as const;

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: toLeanJson(data) }] };
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
  if (/OUT_OF_RANGE|maximum.*range|range.*maximum/i.test(message))
    return "Query range too long — heart-rate, total-calories, active-minutes and calories-in-heart-rate-zone are capped at 14 days per query; other data types at 90 days. Retry with a shorter range.";
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
  purgeCache: () => Promise<number>,
) {
  // The headline tool: one call to decide "should I train today?"
  server.registerTool(
    "get_recovery_snapshot",
    {
      title: "Recovery Snapshot",
      description: "Get last night's recovery signals (sleep, resting heart rate, HRV, and skin-temperature variation) for a single day. Use this to judge training readiness for today. Defaults to the most recent day.",
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day to fetch, YYYY-MM-DD. Defaults to today.") },
      annotations: READ_ONLY,
    },
    async ({ date }) => {
      try {
        const day = date ?? todayIso(timeZone);
        const client = getClient();
        const [sleep, restingHr, hrv, skinTemp] = await Promise.all([
          client.reconcile(DATA_TYPE.sleep, day, day, SLEEP_FILTER),
          client.reconcile(DATA_TYPE.restingHeartRate, day, day, BY_DATE),
          client.reconcile(DATA_TYPE.heartRateVariability, day, day, BY_DATE),
          client.reconcile(DATA_TYPE.skinTemperature, day, day, BY_DATE),
        ]);
        return jsonResult({ date: day, sleep, restingHeartRate: restingHr, hrv, skinTemperature: skinTemp });
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
      description: "Get an all-day activity/load summary over a date range: active-zone-minutes, steps, distance, total calories burned, and resting heart rate. Complements Strava workout data with all-day load.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [azm, steps, distance, totalCalories, restingHr] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.activeZoneMinutes, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.steps, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.distance, start_date, end_date),
          // total-calories is capped at a 14-day query range by the API;
          // fetch best-effort so a long range doesn't fail the whole tool.
          client.dailyRollUp(DATA_TYPE.totalCalories, start_date, end_date).catch((err) => ({ skipped: err instanceof Error ? err.message : String(err) })),
          client.reconcile(DATA_TYPE.restingHeartRate, start_date, end_date, BY_DATE),
        ]);
        return jsonResult({ activeZoneMinutes: azm, steps, distance, totalCalories, restingHeartRate: restingHr });
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

  server.registerTool(
    "get_body_composition",
    {
      title: "Body Composition",
      description: "Get body weight, body-fat percentage, and height over a date range. Use for body-composition trends across a training block.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [weight, bodyFat, height] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.weight, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.bodyFat, start_date, end_date),
          client.reconcile(DATA_TYPE.height, start_date, end_date, BY_SAMPLE_TIME),
        ]);
        return jsonResult({ weight, bodyFat, height });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_vitals_trend",
    {
      title: "Vitals & Fitness Trend",
      description: "Get daily overnight vitals and fitness markers over a date range: respiratory rate, blood-oxygen saturation (SpO2), skin-temperature variation, core body temperature, blood glucose, and estimated VO2 max (all-round + running-specific). Rising respiratory rate, falling SpO2, or elevated skin temperature can flag illness or under-recovery; VO2 max tracks aerobic fitness.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [respiratoryRate, oxygenSaturation, vo2Max, runVo2Max, skinTemperature, coreBodyTemperature, bloodGlucose] = await Promise.all([
          client.reconcile(DATA_TYPE.respiratoryRate, start_date, end_date, BY_DATE),
          client.reconcile(DATA_TYPE.oxygenSaturation, start_date, end_date, BY_DATE),
          client.reconcile(DATA_TYPE.vo2Max, start_date, end_date, BY_DATE),
          client.dailyRollUp(DATA_TYPE.runVo2Max, start_date, end_date),
          client.reconcile(DATA_TYPE.skinTemperature, start_date, end_date, BY_DATE),
          client.dailyRollUp(DATA_TYPE.coreBodyTemperature, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.bloodGlucose, start_date, end_date),
        ]);
        return jsonResult({ respiratoryRate, oxygenSaturation, vo2Max, runVo2Max, skinTemperature, coreBodyTemperature, bloodGlucose });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_exercise_sessions",
    {
      title: "Exercise Sessions",
      description: "Get logged exercise/workout sessions over a date range: activity type, duration, and per-session stats as recorded by the watch. Complements Strava for sessions that were never synced there (gym work, walks, sports).",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        return jsonResult(await getClient().reconcile(DATA_TYPE.exercise, start_date, end_date));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_heart_rate_zones",
    {
      title: "Heart Rate Zones",
      description: "Get daily heart-rate-zone data over a date range: the day's zone boundaries plus time spent in each zone. Use to judge intensity distribution (e.g. polarized vs threshold-heavy training). Note: calories-in-zone is only included for ranges of 14 days or less (API limit).",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [zones, timeInZone, caloriesInZone] = await Promise.all([
          client.reconcile(DATA_TYPE.heartRateZones, start_date, end_date, BY_DATE),
          client.dailyRollUp(DATA_TYPE.timeInHeartRateZone, start_date, end_date),
          // calories-in-heart-rate-zone is capped at a 14-day query range by the
          // API; fetch it best-effort so a long range doesn't fail the whole tool.
          client.dailyRollUp(DATA_TYPE.caloriesInHeartRateZone, start_date, end_date).catch((err) => ({ skipped: err instanceof Error ? err.message : String(err) })),
        ]);
        return jsonResult({ zones, timeInZone, caloriesInZone });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_activity_detail",
    {
      title: "Activity Detail",
      description: "Get extended daily activity metrics over a date range: floors climbed, active minutes, active energy burned, sedentary time, swim lengths, and altitude. Use when the standard daily summary isn't enough (e.g. checking sedentary load on rest days or swim volume).",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD. Active-minutes is capped at 14 days per query by the API."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [floors, activeMinutes, activeEnergyBurned, sedentaryPeriod, swimLengths, altitude] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.floors, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.activeMinutes, start_date, end_date).catch((err) => ({ skipped: err instanceof Error ? err.message : String(err) })),
          client.dailyRollUp(DATA_TYPE.activeEnergyBurned, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.sedentaryPeriod, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.swimLengths, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.altitude, start_date, end_date),
        ]);
        return jsonResult({ floors, activeMinutes, activeEnergyBurned, sedentaryPeriod, swimLengths, altitude });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_cardiac_events",
    {
      title: "Cardiac Events (ECG & Irregular Rhythm)",
      description: "Get ECG recordings taken on the watch and irregular-rhythm (possible AFib) notifications over a date range. Requires the ECG/IRN OAuth scopes — if this errors with a permission problem, reconnect the connector after adding those scopes. Informational only, not a medical diagnosis.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [ecg, irregularRhythm] = await Promise.all([
          client.listByDate(DATA_TYPE.electrocardiogram, start_date, end_date, ECG_FILTER),
          client.listByDate(DATA_TYPE.irregularRhythm, start_date, end_date, BY_SAMPLE_TIME),
        ]);
        return jsonResult({ ecg, irregularRhythm });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Escape hatch: query any Google Health data type directly, including ones
  // without a dedicated tool (activity-level, respiratory-rate-sleep-summary,
  // intraday heart-rate-variability / oxygen-saturation) and types Google adds
  // in the future — no redeploy needed.
  server.registerTool(
    "query_data_type",
    {
      title: "Query Any Data Type (advanced)",
      description: "Directly query any Google Health API v4 data type by ID over a date range — an escape hatch for metrics without a dedicated tool (e.g. activity-level, respiratory-rate-sleep-summary, intraday heart-rate-variability or oxygen-saturation) or newly released types. Method guide: dailyRollUp for daily aggregates of interval types (steps, heart-rate, floors); reconcile for daily-* computed types (time_member=\"date\"), sessions (sleep: time_member=\"interval.end_time\" physical; exercise: default), and measurements (time_member=\"sample_time.physical_time\" physical); list only for electrocardiogram/irregular-rhythm-notification.",
      inputSchema: {
        data_type: z.string().regex(/^[a-z0-9-]+$/).describe("Data type ID in kebab-case, e.g. \"activity-level\"."),
        method: z.enum(["dailyRollUp", "reconcile", "list"]).default("reconcile").describe("API method to use — see the method guide in the tool description."),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
        time_member: z.string().optional().describe("Filter time member for reconcile/list. Default \"interval.civil_start_time\". Use \"date\" for daily-* types, \"interval.end_time\" (+physical) for sleep, \"sample_time.physical_time\" (+physical) for measurement types."),
        physical: z.boolean().optional().describe("Set true when the time member is a physical Timestamp (RFC3339-Z) rather than a civil date."),
      },
      annotations: READ_ONLY,
    },
    async ({ data_type, method, start_date, end_date, time_member, physical }) => {
      try {
        const client = getClient();
        const opts = { timeMember: time_member, physical };
        const result =
          method === "dailyRollUp"
            ? await client.dailyRollUp(data_type, start_date, end_date)
            : method === "list"
              ? await client.listByDate(data_type, start_date, end_date, opts)
              : await client.reconcile(data_type, start_date, end_date, opts);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_my_data",
    {
      title: "Delete My Cached Data",
      description: "Delete all of your health data cached by this connector. This does not change your data in Google Health. To fully revoke access, also remove this app in your Google Account permissions and disconnect the connector in Claude.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const deleted = await purgeCache();
        return jsonResult({
          deletedCacheEntries: deleted,
          note: "Cached data cleared. To fully revoke access, remove this app at https://myaccount.google.com/permissions and disconnect the connector in Claude.",
        });
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
        { metric: "steps", run: () => client.dailyRollUp(DATA_TYPE.steps, start, end) },
        { metric: "distance", run: () => client.dailyRollUp(DATA_TYPE.distance, start, end) },
        { metric: "total_calories", run: () => client.dailyRollUp(DATA_TYPE.totalCalories, start, end) },
        { metric: "weight", run: () => client.dailyRollUp(DATA_TYPE.weight, start, end) },
        { metric: "body_fat", run: () => client.dailyRollUp(DATA_TYPE.bodyFat, start, end) },
        { metric: "respiratory_rate", run: () => client.reconcile(DATA_TYPE.respiratoryRate, start, end, BY_DATE) },
        { metric: "oxygen_saturation", run: () => client.reconcile(DATA_TYPE.oxygenSaturation, start, end, BY_DATE) },
        { metric: "vo2_max", run: () => client.reconcile(DATA_TYPE.vo2Max, start, end, BY_DATE) },
        { metric: "run_vo2_max", run: () => client.dailyRollUp(DATA_TYPE.runVo2Max, start, end) },
        { metric: "nutrition", run: () => client.dailyRollUp(DATA_TYPE.nutrition, start, end) },
        { metric: "hydration", run: () => client.dailyRollUp(DATA_TYPE.hydration, start, end) },
        { metric: "skin_temperature", run: () => client.reconcile(DATA_TYPE.skinTemperature, start, end, BY_DATE) },
        { metric: "core_body_temperature", run: () => client.dailyRollUp(DATA_TYPE.coreBodyTemperature, start, end) },
        { metric: "blood_glucose", run: () => client.dailyRollUp(DATA_TYPE.bloodGlucose, start, end) },
        { metric: "heart_rate_zones", run: () => client.reconcile(DATA_TYPE.heartRateZones, start, end, BY_DATE) },
        { metric: "time_in_heart_rate_zone", run: () => client.dailyRollUp(DATA_TYPE.timeInHeartRateZone, start, end) },
        { metric: "calories_in_heart_rate_zone", run: () => client.dailyRollUp(DATA_TYPE.caloriesInHeartRateZone, start, end) },
        { metric: "exercise", run: () => client.reconcile(DATA_TYPE.exercise, start, end) },
        { metric: "floors", run: () => client.dailyRollUp(DATA_TYPE.floors, start, end) },
        { metric: "active_minutes", run: () => client.dailyRollUp(DATA_TYPE.activeMinutes, start, end) },
        { metric: "active_energy_burned", run: () => client.dailyRollUp(DATA_TYPE.activeEnergyBurned, start, end) },
        { metric: "sedentary_period", run: () => client.dailyRollUp(DATA_TYPE.sedentaryPeriod, start, end) },
        { metric: "swim_lengths", run: () => client.dailyRollUp(DATA_TYPE.swimLengths, start, end) },
        { metric: "altitude", run: () => client.dailyRollUp(DATA_TYPE.altitude, start, end) },
        { metric: "height", run: () => client.reconcile(DATA_TYPE.height, start, end, BY_SAMPLE_TIME) },
        { metric: "respiratory_rate_sleep_summary", run: () => client.reconcile(DATA_TYPE.respiratoryRateSleepSummary, start, end, BY_SAMPLE_TIME) },
        { metric: "electrocardiogram", run: () => client.listByDate(DATA_TYPE.electrocardiogram, start, end, ECG_FILTER) },
        { metric: "irregular_rhythm_notification", run: () => client.listByDate(DATA_TYPE.irregularRhythm, start, end, BY_SAMPLE_TIME) },
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
