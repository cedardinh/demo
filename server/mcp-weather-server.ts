import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { config } from "dotenv";
import { z } from "zod";

// 加载本地 .env 到 process.env，供 MCP 运行时读取私钥与接口配置。
config();

// 运行时配置说明：
// - 私钥决定由哪个钱包执行 x402 支付签名
// - baseURL/endpointPath 决定天气数据请求目标
// - timeout 用于避免在聊天客户端中长时间卡住
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);

// 至少需要一个可用签名器（EVM 或 SVM），否则无法完成任何 x402 支付流程。
if (!evmPrivateKey && !svmPrivateKey) {
  throw new Error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
}

/**
 * 构建带 x402 自动支付能力的 axios 客户端。
 *
 * 流程：
 * 1) 创建 x402 客户端容器
 * 2) 使用配置中的私钥注册 EVM 和/或 SVM 支付方案
 * 3) 用支付中间件包装 axios，使 HTTP 402 可自动支付并重试
 */
async function createPaidHttpClient() {
  const client = new x402Client();

  // 若提供了 EVM 私钥，则注册 EVM 签名器（例如 Base Sepolia）。
  if (evmPrivateKey) {
    registerExactEvmScheme(client, { signer: privateKeyToAccount(evmPrivateKey) });
  }

  // 若提供了 SVM 私钥，则注册 SVM（Solana）签名器。
  if (svmPrivateKey) {
    const kitModule = (await import("@solana/kit")) as unknown as {
      createKeyPairSignerFromBytes: (secret: Uint8Array) => Promise<unknown>;
    };
    const signer = await kitModule.createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    registerExactSvmScheme(client, { signer: signer as never });
  }

  return wrapAxiosWithPayment(
    axios.create({
      baseURL,
      timeout: requestTimeoutMs
    }),
    client
  );
}

type RawToolResult = {
  ok: boolean;
  source: {
    url: string;
    path: string;
  };
  request: Record<string, unknown>;
  upstream: {
    status: number | null;
    payment_response_header: string | null;
    x_payment_response_header: string | null;
    data: unknown;
  };
};

/**
 * 以不区分大小写的方式读取响应头。
 * Axios/Node 可能会对 header 名做不同规范化，因此同时尝试原始/小写/大写键名。
 */
function getHeaderValue(headers: unknown, key: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const map = headers as Record<string, unknown>;
  const direct = map[key] ?? map[key.toLowerCase()] ?? map[key.toUpperCase()];
  if (Array.isArray(direct)) {
    return typeof direct[0] === "string" ? direct[0] : undefined;
  }
  return typeof direct === "string" ? direct : undefined;
}

// 安全序列化工具，避免因循环引用导致输出渲染失败。
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "Failed to serialize response" }, null, 2);
  }
}

/**
 * 统一输出原始响应，避免在服务端进行业务字段解析。
 * 由上层 AI 根据该 JSON 自行解释并组织人类可读内容。
 */
function toRawOutput(result: RawToolResult): string {
  return safeJsonStringify(result);
}

/**
 * MCP 服务启动入口。
 *
 * 注册两个工具：
 * 1) get-weather(city, date?)：按城市查询，直接返回上游原始响应
 * 2) get-data-from-resource-server()：直接访问资源端点，返回上游原始响应
 */
async function main() {
  const api = await createPaidHttpClient();

  const server = new McpServer({
    name: "x402-weather-agent",
    version: "1.0.0"
  });

  server.tool(
    "get-weather",
    "Get weather for a city and optional date",
    {
      city: z.string().min(1).describe("City name, e.g. Beijing"),
      date: z.string().optional().describe("Optional date, e.g. 2026-02-13")
    },
    async ({ city, date }) => {
      try {
        // 该请求由支付包装器处理：遇到 HTTP 402 时会自动完成支付并重试。
        const response = await api.get(endpointPath, {
          params: { city, date }
        });
        const result: RawToolResult = {
          ok: true,
          source: {
            url: baseURL,
            path: endpointPath
          },
          request: {
            tool: "get-weather",
            city,
            date: date ?? null
          },
          upstream: {
            status: response.status ?? 200,
            payment_response_header: getHeaderValue(response.headers, "payment-response") ?? null,
            x_payment_response_header: getHeaderValue(response.headers, "x-payment-response") ?? null,
            data: response.data
          }
        };

        return {
          content: [
            {
              type: "text",
              text: toRawOutput(result)
            }
          ]
        };
      } catch (error) {
        const result: RawToolResult = {
          ok: false,
          source: {
            url: baseURL,
            path: endpointPath
          },
          request: {
            tool: "get-weather",
            city,
            date: date ?? null
          },
          upstream: {
            status: axios.isAxiosError(error) ? (error.response?.status ?? null) : null,
            payment_response_header: axios.isAxiosError(error)
              ? getHeaderValue(error.response?.headers, "payment-response") ?? null
              : null,
            x_payment_response_header: axios.isAxiosError(error)
              ? getHeaderValue(error.response?.headers, "x-payment-response") ?? null
              : null,
            data: axios.isAxiosError(error) ? error.response?.data ?? { message: error.message } : { message: String(error) }
          }
        };
        return {
          content: [
            {
              type: "text",
              text: toRawOutput(result)
            }
          ]
        };
      }
    }
  );

  server.tool(
    "get-data-from-resource-server",
    "Fetch data from the configured resource endpoint with x402 auto-payment",
    {},
    async () => {
      try {
        // 极简抓取模式：直接返回上游原始响应，不做业务解析。
        const response = await api.get(endpointPath);
        const result: RawToolResult = {
          ok: true,
          source: {
            url: baseURL,
            path: endpointPath
          },
          request: {
            tool: "get-data-from-resource-server"
          },
          upstream: {
            status: response.status ?? 200,
            payment_response_header: getHeaderValue(response.headers, "payment-response") ?? null,
            x_payment_response_header: getHeaderValue(response.headers, "x-payment-response") ?? null,
            data: response.data
          }
        };

        return {
          content: [
            {
              type: "text",
              text: toRawOutput(result)
            }
          ]
        };
      } catch (error) {
        const result: RawToolResult = {
          ok: false,
          source: {
            url: baseURL,
            path: endpointPath
          },
          request: {
            tool: "get-data-from-resource-server"
          },
          upstream: {
            status: axios.isAxiosError(error) ? (error.response?.status ?? null) : null,
            payment_response_header: axios.isAxiosError(error)
              ? getHeaderValue(error.response?.headers, "payment-response") ?? null
              : null,
            x_payment_response_header: axios.isAxiosError(error)
              ? getHeaderValue(error.response?.headers, "x-payment-response") ?? null
              : null,
            data: axios.isAxiosError(error) ? error.response?.data ?? { message: error.message } : { message: String(error) }
          }
        };

        return {
          content: [
            {
              type: "text",
              text: toRawOutput(result)
            }
          ]
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  // 启动 stdio 传输层，使 MCP 客户端可在当前进程调用工具。
  await server.connect(transport);
}

// 顶层异常保护：避免静默退出，并输出可见错误信息。
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
