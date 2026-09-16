# Connect your AI

Choose [hosted or local mode](access-methods.md) first. Hosted mode uses `https://api.beamswap.io/mcp` and asks for wallet approval in the browser. Local mode uses the [npm package or source build](../README.md#run-the-local-server). Wherever this guide shows `node /absolute/path/to/beamswap-mcp/dist/index.js`, you can use `npx -y @beamswap/mcp@0.1.0` for the packaged server instead.

Provider menus and plan access can change. These instructions were checked against official documentation on 16 September 2026. Protocol tests do not mean every provider account or plan has been tested.

## Claude

**Hosted:** use Claude's custom remote connector setup and enter `https://api.beamswap.io/mcp`. No Beamswap API key is required. Enable the connector in the conversation and ask it to list its tools.

**Claude Desktop, local:** open Settings > Developer > Edit Config. Add the `mcpServers.beamswap` entry from the README, keeping other entries. Restart Claude Desktop and check that Beamswap is connected.

**Claude Code, local:**

```sh
claude mcp add --transport stdio --scope user beamswap -- node "/absolute/path/to/beamswap-mcp/dist/index.js"
```

Sources: [remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Desktop setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Claude Code](https://code.claude.com/docs/en/mcp).

## ChatGPT

For accounts with developer mode, open Settings > Security and login and enable Developer mode. Open Plugins, select the plus button, and create an MCP connection with URL `https://api.beamswap.io/mcp`. Select no authentication if requested. Add the connection to a conversation and inspect its tools. Workspace policy can restrict this feature.

Advanced users can select **Tunnel** instead and connect the local stdio server through Secure MCP Tunnel. Keep the tunnel client running. Most users should choose hosted mode.

Sources: [ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), [private tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Gemini

Use **Gemini CLI** for MCP. The ordinary Gemini chat interface is a separate product and is not covered by these commands.

```sh
# Hosted
gemini mcp add --transport http beamswap https://api.beamswap.io/mcp

# Or local, after building this repository
gemini mcp add beamswap node "/absolute/path/to/beamswap-mcp/dist/index.js"
```

Run `/mcp` inside Gemini CLI to inspect the connection. Review the available tools before granting tool access.

Source: [Gemini CLI MCP setup](https://geminicli.com/docs/tools/mcp-server/).

## Perplexity

If your account offers a **Remote** custom connector, enter the hosted MCP URL in Connectors and enable it for the conversation. Availability varies by app, plan and workspace.

For the **Mac app's local mode**, open Settings > Connectors, install the PerplexityXPC helper if prompted, then add a connector with command `node /absolute/path/to/beamswap-mcp/dist/index.js`. Save, wait for Running, and enable it under Sources. Configure the local process environment separately before using paid tools.

Sources: [local setup](https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity), [custom connector availability](https://www.perplexity.ai/en-GB/changelog/what-we-shipped---march-13-2026).

## Grok and Grok Bot

**Grok web:** open [Connectors](https://grok.com/connectors), choose New Connector > Custom, and enter the hosted MCP URL. Enable it in a conversation. Team administrators may need to allow custom connectors.

**Grok Build, local:**

```sh
grok mcp add beamswap -- node "/absolute/path/to/beamswap-mcp/dist/index.js"
grok mcp doctor beamswap
```

**Grok Bot:** where its connector settings expose the custom connector, use hosted mode. Otherwise ask it to prepare a recipient CSV or review your plan, then finish through the Beamswap website. Do not put a wallet private key into a Bot's shared files or chat. We have not verified a separate native Grok Bot MCP installation flow.

Sources: [Grok connectors](https://docs.x.ai/grok/connectors), [Grok Build MCP](https://docs.x.ai/build/features/mcp-servers), [Grok Bot](https://docs.x.ai/grok-bot/overview).

## Codex

```sh
# Hosted
codex mcp add beamswap --url https://api.beamswap.io/mcp

# Or local
codex mcp add beamswap -- node "/absolute/path/to/beamswap-mcp/dist/index.js"
```

Inspect the server with `/mcp`. If it has not appeared, reconnect or restart the client. Use the client environment configuration to forward `BEAMSWAP_WALLET_KEY` only for local paid mode.

Source: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Cursor

Open Cursor's MCP settings or edit `~/.cursor/mcp.json`. Merge this entry with your existing servers:

```json
{
  "mcpServers": {
    "beamswap": {
      "url": "https://api.beamswap.io/mcp"
    }
  }
}
```

For local mode, replace `url` with the command and arguments from the README. Enable the server and inspect its available tools before granting access.

Source: [Cursor MCP](https://cursor.com/docs/mcp).

## Any other MCP client

If the client supports **Streamable HTTP**, use the hosted URL. If it supports **stdio**, use command `node` and the absolute path to the built file. A client that supports only legacy SSE is not covered by the hosted endpoint. Follow the client's documentation rather than changing the URL to an invented `/sse` path.

## First request

“List the Beamswap tools without spending anything. Then explain how to check the Base balances of [my public wallet address]. Ask before making a paid request.”

Listing tools is free. A prompt asking for confirmation is guidance to the model, not an enforced local spending limit. Hosted browser approval and local automatic payments are different modes.
