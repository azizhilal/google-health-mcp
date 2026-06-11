/**
 * Coaching-oriented MCP tools. These are intentionally higher-level than the
 * raw Google Health endpoints: each one answers a question a coach actually
 * asks ("how recovered am I?", "what's my HRV trend?") and returns compact JSON
 * for Claude to reason over alongside Strava workout data.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleHealthClient } from "./google-health";

/** Data type IDs in the Google Health API v4. */
const DATA_TYPE = {
  restingHeartRate: "resting-heart-rate",
  heartRateVariability: "heart-rate-variability",
  sleep: "sleep",
  heartRate: "heart-rate",
  activeZoneMinutes: "active-zone-minutes",
} as const;

/** "YYYY-MM-DD" for a date N days before today (UTC). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/**
 * Register all tools on the MCP server. `getClient` defers client construction
 * to call-time so token refresh works against live props.
 */
export function registerTools(server: McpServer, getClient: () => GoogleHealthClient) {
  // The headline tool: one call to decide "should I train today?"
  server.tool(
    "get_recovery_snapshot",
    "Get last night's recovery signals (sleep, resting heart rate, and HRV) for a single day. Use this to judge training readiness for today. Defaults to the most recent day.",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day to fetch, YYYY-MM-DD. Defaults to today.") },
    async ({ date }) => {
      try {
        const day = date ?? todayIso();
        const client = getClient();
        const [sleep, restingHr, hrv] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.sleep, day, day),
          client.dailyRollUp(DATA_TYPE.restingHeartRate, day, day),
          client.dailyRollUp(DATA_TYPE.heartRateVariability, day, day),
        ]);
        return jsonResult({ date: day, sleep, restingHeartRate: restingHr, hrv });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_hrv_trend",
    "Get daily heart-rate-variability (HRV) values over a recent window to assess autonomic recovery trend. Higher/stable HRV generally indicates good recovery.",
    { days: z.number().int().min(1).max(90).default(14).describe("Number of days back from today.") },
    async ({ days }) => {
      try {
        return jsonResult(await getClient().dailyRollUp(DATA_TYPE.heartRateVariability, isoDaysAgo(days), todayIso()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_resting_hr_trend",
    "Get daily resting heart rate over a recent window. A rising resting HR can signal accumulated fatigue, illness, or under-recovery.",
    { days: z.number().int().min(1).max(90).default(14).describe("Number of days back from today.") },
    async ({ days }) => {
      try {
        return jsonResult(await getClient().dailyRollUp(DATA_TYPE.restingHeartRate, isoDaysAgo(days), todayIso()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_sleep",
    "Get daily sleep summaries (duration and stages) over a date range. Use for sleep-debt and consistency analysis.",
    {
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
    },
    async ({ start_date, end_date }) => {
      try {
        return jsonResult(await getClient().dailyRollUp(DATA_TYPE.sleep, start_date, end_date));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_daily_summary",
    "Get an activity/load summary for a date range: active-zone-minutes and resting heart rate. Complements Strava workout data with all-day load.",
    {
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive start, YYYY-MM-DD."),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Inclusive end, YYYY-MM-DD."),
    },
    async ({ start_date, end_date }) => {
      try {
        const client = getClient();
        const [azm, restingHr] = await Promise.all([
          client.dailyRollUp(DATA_TYPE.activeZoneMinutes, start_date, end_date),
          client.dailyRollUp(DATA_TYPE.restingHeartRate, start_date, end_date),
        ]);
        return jsonResult({ activeZoneMinutes: azm, restingHeartRate: restingHr });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
