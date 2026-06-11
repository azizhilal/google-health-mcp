/**
 * Minimal client for the Google Health API v4 (the Fitbit-data cloud API).
 *
 * Docs: https://developers.google.com/health/reference/rest/v4
 *
 * We deliberately keep this thin: tools mostly pass the API's JSON straight
 * through to Claude, which is perfectly capable of reasoning over structured
 * health data. The client's only real jobs are (1) building the slightly fiddly
 * dailyRollUp request bodies and (2) transparently refreshing the access token.
 */

const HEALTH_BASE = "https://health.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A calendar date as the API's CivilDateTime (no time component = whole day). */
interface CivilDateTime {
  year: number;
  month: number;
  day: number;
}

export interface GoogleHealthClientOptions {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
}

/** Parse a "YYYY-MM-DD" string into the API's CivilDateTime shape. */
function toCivilDate(isoDate: string): CivilDateTime {
  const [year, month, day] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (!year || !month || !day) {
    throw new Error(`Invalid date "${isoDate}" — expected YYYY-MM-DD`);
  }
  return { year, month, day };
}

export class GoogleHealthClient {
  private accessToken: string;
  private readonly refreshToken?: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(opts: GoogleHealthClientOptions) {
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
  }

  /**
   * Daily-aggregated values for a data type over an inclusive date range.
   * Best for trends: resting HR, HRV, sleep summaries, active-zone-minutes.
   *
   * @param dataType e.g. "resting-heart-rate", "heart-rate-variability", "sleep"
   * @param startDate inclusive "YYYY-MM-DD"
   * @param endDate   inclusive "YYYY-MM-DD"
   */
  async dailyRollUp(
    dataType: string,
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
    const body = {
      range: {
        start: toCivilDate(startDate),
        end: toCivilDate(endDate),
      },
    };
    return this.request(url, { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * Raw individual data points for a data type within a time window.
   * Use when you need intra-day detail rather than daily rollups.
   *
   * @param dataType   e.g. "heart-rate", "sleep"
   * @param startTime  RFC-3339 timestamp, e.g. "2026-06-10T00:00:00Z"
   * @param endTime    RFC-3339 timestamp, exclusive upper bound
   * @param pageSize   optional cap (API default 1440; sleep/exercise max 25)
   */
  async list(
    dataType: string,
    startTime: string,
    endTime: string,
    pageSize?: number,
  ): Promise<unknown> {
    // The filter field is "<dataType>.interval.start_time" (underscored) per AIP-160.
    const field = `${dataType.replace(/-/g, "_")}.interval.start_time`;
    const filter = `${field} >= "${startTime}" AND ${field} < "${endTime}"`;
    const params = new URLSearchParams({ filter });
    if (pageSize) params.set("pageSize", String(pageSize));
    const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints?${params}`;
    return this.request(url, { method: "GET" });
  }

  /** Fetch with bearer auth; on 401, refresh the token once and retry. */
  private async request(
    url: string,
    init: RequestInit,
    retried = false,
  ): Promise<unknown> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 && this.refreshToken && !retried) {
      await this.refresh();
      return this.request(url, init, true);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Google Health API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }
    return res.json();
  }

  /** Exchange the refresh token for a fresh access token (mutates in place). */
  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error("No refresh token available");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string };
    this.accessToken = json.access_token;
  }
}
