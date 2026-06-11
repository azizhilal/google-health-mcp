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
import type { Env, Props } from "./types";

export class GoogleHealthMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Google Health",
    title: "Google Health",
    version: "0.1.0",
    websiteUrl: "https://google-health-mcp.a1dancole.workers.dev",
    icons: [
      {
        src: "https://google-health-mcp.a1dancole.workers.dev/icon.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
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
        }),
    );
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
