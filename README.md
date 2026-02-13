# x402 MCP Weather Chat Agent

This project provides an MCP server tool (`get-weather`) that can be called by a chat client.  
When the target API requires payment (HTTP 402), x402 payment is handled automatically.

## Requirements

- Node.js 20+
- npm (or pnpm)
- EVM or Solana wallet private key with USDC
- An x402-compatible weather API endpoint

Reference guide: <https://raw.githubusercontent.com/coinbase/x402/main/docs/guides/mcp-server-with-x402.md>

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp server/.env.example .env
```

3. Fill `.env` values:

- `EVM_PRIVATE_KEY` or `SVM_PRIVATE_KEY` (at least one required)
- `RESOURCE_SERVER_URL` (e.g. `http://localhost:4021`)
- `ENDPOINT_PATH` (e.g. `/weather`)

## Run

```bash
npm run dev
```

## Build

```bash
npm run build
```

## MCP Tool

- Tool name: `get-weather`
- Input:
  - `city` (string, required)
  - `date` (string, optional, e.g. `2026-02-13`)
- Output:
  - human-friendly summary + `machine_json` block

- Tool name: `get-data-from-resource-server`
- Input:
  - none
- Output:
  - human-friendly summary + `machine_json` block
  - machine JSON always includes:
    - `payment_success`
    - `transaction_hash`
    - `weather_json`

### Output Demo

```text
x402 Resource Result
- payment_success: NOT_COMPLETED
- transaction_hash: N/A
- Service error: insufficient_funds

machine_json
{
  "payment_success": false,
  "transaction_hash": null,
  "weather_json": {
    "x402Version": 1,
    "error": "insufficient_funds"
  }
}
```

## Claude Desktop / MCP Client Configuration

Example `mcpServers` config:

```json
{
  "mcpServers": {
    "x402-weather-agent": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/absolute/path/to/this/project",
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "RESOURCE_SERVER_URL": "http://localhost:4021",
        "ENDPOINT_PATH": "/weather"
      }
    }
  }
}
```

## Quick Validation

Try in your chat client:

- "What's the weather in Beijing today?"
- "Tell me tomorrow's weather in Shanghai."
- "What's the weather in Shenzhen on 2026-02-13?"

Expected:

- Valid weather response for existing city data
- Automatic retry when API returns HTTP 402
- Friendly error message for timeout / invalid city / insufficient balance
