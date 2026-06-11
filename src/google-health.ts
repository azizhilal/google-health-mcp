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

import { toCivilDate, nextDayIso } from "./dates";

const HEALTH_BASE = "https://health.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Transient (retryable) HTTP statuses and how many times we'll back off. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
/** Stop following pagination after this many pages (safety against loops). */
const MAX_PAGES = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GoogleHealthClientOptions {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
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
    // CivilTimeInterval: start inclusive, end exclusive. Each bound is a
    // CivilDateTime ({ date, time? }); omitting `time` defaults to midnight,
    // which aligns with the daily aggregation window. We advance the caller's
    // inclusive end by one day to make it the exclusive upper bound.
    const range = {
      start: { date: toCivilDate(startDate) },
      end: { date: toCivilDate(nextDayIso(endDate)) },
    };
    // pageToken (when present) goes in the POST body for this method.
    return this.paginate("rollupDataPoints", (pageToken) =>
      this.request(url, {
        method: "POST",
        body: JSON.stringify(pageToken ? { range, pageToken } : { range }),
      }),
    );
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
    // pageToken (when present) goes in the query string for this method.
    return this.paginate("dataPoints", (pageToken) => {
      const params = new URLSearchParams({ filter });
      if (pageSize) params.set("pageSize", String(pageSize));
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints?${params}`;
      return this.request(url, { method: "GET" });
    });
  }

  /**
   * Reconciled data points over an inclusive date range. This is the right
   * method for daily-aggregated types — `daily-resting-heart-rate`,
   * `daily-heart-rate-variability`, `sleep` — which do NOT support dailyRollUp.
   *
   * The filterable time member differs by data type: interval types like
   * `sleep` filter on `interval.civil_start_time`, whereas the daily computed
   * types expose a single `date` field. Values are plain "YYYY-MM-DD"; the
   * inclusive end is advanced one day to form the exclusive upper bound.
   *
   * @param dataType    e.g. "daily-resting-heart-rate", "sleep"
   * @param startDate   inclusive "YYYY-MM-DD"
   * @param endDate     inclusive "YYYY-MM-DD"
   * @param opts.timeMember        member path after the data type, default
   *                               "interval.civil_start_time"; use "date" for daily types
   * @param opts.dataSourceFamily  optional, e.g. "users/me/dataSourceFamilies/google-wearables"
   */
  async reconcile(
    dataType: string,
    startDate: string,
    endDate: string,
    opts: { timeMember?: string; dataSourceFamily?: string; physical?: boolean } = {},
  ): Promise<unknown> {
    const field = `${dataType.replace(/-/g, "_")}.${opts.timeMember ?? "interval.civil_start_time"}`;
    // Physical-time members (Timestamps) want RFC3339 with a Z; civil members
    // want a plain calendar date. End bound is exclusive (next day).
    const fmt = (iso: string) => (opts.physical ? `${iso}T00:00:00Z` : iso);
    const filter = `${field} >= "${fmt(startDate)}" AND ${field} < "${fmt(nextDayIso(endDate))}"`;
    return this.paginate("dataPoints", (pageToken) => {
      const params = new URLSearchParams({ filter });
      if (opts.dataSourceFamily) params.set("dataSourceFamily", opts.dataSourceFamily);
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints:reconcile?${params}`;
      return this.request(url, { method: "GET" });
    });
  }

  /**
   * Follow `nextPageToken` until exhausted, concatenating each page's
   * `arrayKey` array into the first page's response. Returns the merged
   * response object with `nextPageToken` stripped.
   */
  private async paginate(
    arrayKey: "dataPoints" | "rollupDataPoints",
    fetchPage: (pageToken?: string) => Promise<unknown>,
  ): Promise<unknown> {
    const merged = (await fetchPage()) as Record<string, unknown>;
    const hadKey = Array.isArray(merged[arrayKey]);
    const items = hadKey ? (merged[arrayKey] as unknown[]) : [];
    let token = merged.nextPageToken as string | undefined;

    for (let page = 1; token && page < MAX_PAGES; page++) {
      const next = (await fetchPage(token)) as Record<string, unknown>;
      if (Array.isArray(next[arrayKey])) items.push(...(next[arrayKey] as unknown[]));
      token = next.nextPageToken as string | undefined;
    }

    // Don't synthesize an empty array if the response keys data elsewhere.
    if (!hadKey && items.length === 0) {
      delete merged.nextPageToken;
      return merged;
    }

    merged[arrayKey] = items;
    delete merged.nextPageToken;
    return merged;
  }

  /**
   * Fetch with bearer auth. On 401 we refresh the token once and retry; on a
   * transient status (429/5xx) we back off and retry up to MAX_RETRIES,
   * honouring a Retry-After header when present.
   */
  private async request(
    url: string,
    init: RequestInit,
    state: { authRetried: boolean; attempt: number } = { authRetried: false, attempt: 0 },
  ): Promise<unknown> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 && this.refreshToken && !state.authRetried) {
      await this.refresh();
      return this.request(url, init, { ...state, authRetried: true });
    }

    if (RETRYABLE_STATUSES.has(res.status) && state.attempt < MAX_RETRIES) {
      await sleep(this.backoffMs(res, state.attempt));
      return this.request(url, init, { ...state, attempt: state.attempt + 1 });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Google Health API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }
    return res.json();
  }

  /** Backoff delay: Retry-After if the server sent one, else exponential with jitter. */
  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!Number.isNaN(secs)) return Math.min(secs * 1000, 10_000);
    }
    return Math.min(2 ** attempt * 300 + Math.random() * 200, 5_000);
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
