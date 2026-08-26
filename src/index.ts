/**
 * Entry point. Wires three things together:
 *   1. workers-oauth-provider  — makes this Worker an OAuth server to Claude.
 *   2. GoogleHandler           — bridges to Google's consent (upstream IdP).
 *   3. GoogleHealthMCP (McpAgent / Durable Object) — serves the MCP tools.
 *
 * Add the deployed URL (".../mcp") to Claude as a custom connector; clicking
 * "Connect" runs the Google consent and the tools light up on web/desktop/mobile.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleHandler } from "./google-handler";
import { GoogleHealthClient } from "./google-health";
import { registerTools } from "./tools";
import { ICON_PNG_SIZES } from "./icon";
import type { Env, Props } from "./types";

export class GoogleHealthMCP extends McpAgent<Env, Record<string, never>, Props> {
  // `this.env` is set by the Durable Object base constructor, so it is
  // available to field initialisers. PUBLIC_URL lets clients that render
  // server branding (Claude's connector list) show the icon served at /icon.png.
  server = new McpServer({
    name: "Google Health",
    title: "Google Health",
    version: "0.1.0",
    ...(this.env?.PUBLIC_URL
      ? {
          websiteUrl: this.env.PUBLIC_URL,
          icons: [{ src: `${this.env.PUBLIC_URL.replace(/\/$/, "")}/icon.png`, mimeType: "image/png", sizes: [ICON_PNG_SIZES] }],
        }
      : {}),
  });

  async init() {
    registerTools(
      this.server,
      () =>
        new GoogleHealthClient({
          accessToken: this.props.accessToken,
          refreshToken: this.props.refreshToken,
          clientId: this.env.GOOGLE_CLIENT_ID,
          clientSecret: this.env.GOOGLE_CLIENT_SECRET,
          cache: this.env.HEALTH_CACHE,
          userId: this.props.email,
          timeZone: this.env.TIME_ZONE || "Europe/London",
        }),
      this.env.TIME_ZONE || "Europe/London",
      () => this.purgeCache(),
    );
  }

  /** Delete every cached entry for this user. Backs the delete_my_data tool. */
  private async purgeCache(): Promise<number> {
    const prefix = `v1:${this.props.email}:`;
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.HEALTH_CACHE.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => this.env.HEALTH_CACHE.delete(k.name)));
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return count;
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: GoogleHealthMCP.serve("/mcp") as any,
  defaultHandler: GoogleHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
