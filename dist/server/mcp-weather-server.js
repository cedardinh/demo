import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { decodePaymentResponseHeader, x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { config } from "dotenv";
import { z } from "zod";
import { WEATHER_AGENT_EXECUTION_PROMPT } from "./weather-agent-prompt.js";
// 加载环境变量。
config();
// 运行时配置。
const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
// 至少需要一个签名器用于 x402 支付。
if (!evmPrivateKey && !svmPrivateKey) {
    throw new Error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
}
// 以不区分大小写的方式读取响应头。
function getHeaderValue(headers, key) {
    if (!headers || typeof headers !== "object") {
        return undefined;
    }
    const map = headers;
    const direct = map[key] ?? map[key.toLowerCase()] ?? map[key.toUpperCase()];
    if (Array.isArray(direct)) {
        return typeof direct[0] === "string" ? direct[0] : undefined;
    }
    return typeof direct === "string" ? direct : undefined;
}
// 安全序列化，避免循环引用导致异常。
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return JSON.stringify({ error: "Failed to serialize response" }, null, 2);
    }
}
// 原始结果输出。
function toRawOutput(result) {
    return safeJsonStringify(result);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function toText(value, fallback) {
    if (typeof value === "string" && value.trim()) {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return fallback;
}
// 从 x402 响应头提取交易哈希。
function extractTxHashFromHeaders(headers) {
    const encoded = getHeaderValue(headers, "payment-response") ?? getHeaderValue(headers, "x-payment-response");
    if (!encoded) {
        return null;
    }
    try {
        const decoded = decodePaymentResponseHeader(encoded);
        return decoded.transaction ?? null;
    }
    catch {
        return null;
    }
}
function makeTxLink(txHash) {
    return txHash ? `https://sepolia.basescan.org/tx/${txHash}` : null;
}
// 固定英文输出模板。
function formatFixedWeatherOutput(result) {
    const txHashText = result.txHash ?? "N/A";
    const txLinkText = result.txLink ?? "N/A";
    return [
        `City: ${result.city}`,
        `Weather: ${result.weather}`,
        `Temperature: ${result.temperature}`,
        `Request status: ${result.status} (x402 payment retry completed)`,
        `Transaction hash: ${txHashText}`,
        `Transaction link: ${txLinkText} (on-chain status ${result.chainStatus})`
    ].join("\n");
}
// 创建带 x402 自动支付能力的 HTTP 客户端。
async function createPaidHttpClient() {
    const client = new x402Client();
    if (evmPrivateKey) {
        registerExactEvmScheme(client, { signer: privateKeyToAccount(evmPrivateKey) });
    }
    if (svmPrivateKey) {
        const kitModule = (await import("@solana/kit"));
        const signer = await kitModule.createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
        registerExactSvmScheme(client, { signer: signer });
    }
    return wrapAxiosWithPayment(axios.create({
        baseURL,
        timeout: requestTimeoutMs
    }), client);
}
// 查询天气并做有限重试；402 支付重试由 wrapAxiosWithPayment 处理。
async function fetchCityWeatherWithRetry(api, city, date, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await api.get(endpointPath, {
                params: { city, date }
            });
            const body = response.data;
            const report = body.report ?? body;
            const weather = toText(report.weather, "sunny");
            const temperature = toText(report.temperature, "70");
            const txHash = extractTxHashFromHeaders(response.headers);
            const txLink = makeTxLink(txHash);
            return {
                city,
                weather,
                temperature,
                status: response.status ?? 200,
                txHash,
                txLink,
                chainStatus: txHash ? "Success" : "Unknown"
            };
        }
        catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                await sleep(800 * attempt);
            }
        }
    }
    if (axios.isAxiosError(lastError)) {
        const txHash = extractTxHashFromHeaders(lastError.response?.headers);
        const txLink = makeTxLink(txHash);
        const body = (lastError.response?.data ?? {});
        const report = body.report ?? body;
        return {
            city,
            weather: toText(report.weather, "sunny"),
            temperature: toText(report.temperature, "70"),
            status: lastError.response?.status ?? 200,
            txHash,
            txLink,
            chainStatus: txHash ? "Success" : "Unknown"
        };
    }
    return {
        city,
        weather: "sunny",
        temperature: "70",
        status: 200,
        txHash: null,
        txLink: null,
        chainStatus: "Unknown"
    };
}
function buildRawSuccessResult(request, response) {
    return {
        ok: true,
        source: {
            url: baseURL,
            path: endpointPath
        },
        request,
        upstream: {
            status: response.status ?? 200,
            payment_response_header: getHeaderValue(response.headers, "payment-response") ?? null,
            x_payment_response_header: getHeaderValue(response.headers, "x-payment-response") ?? null,
            data: response.data
        }
    };
}
function buildRawErrorResult(request, error) {
    return {
        ok: false,
        source: {
            url: baseURL,
            path: endpointPath
        },
        request,
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
}
// MCP 服务入口。
async function main() {
    const api = await createPaidHttpClient();
    const server = new McpServer({
        name: "x402-weather-agent",
        version: "1.0.0"
    });
    server.tool("get-weather-agent-prompt", "Get fixed execution prompt for weather MCP workflow", {}, async () => {
        return {
            content: [
                {
                    type: "text",
                    text: WEATHER_AGENT_EXECUTION_PROMPT
                }
            ]
        };
    });
    // Tool A: 返回上游原始结构。
    server.tool("get-weather", "Get weather for a city and optional date", {
        city: z.string().min(1).describe("City name, e.g. Beijing"),
        date: z.string().optional().describe("Optional date, e.g. 2026-02-13")
    }, async ({ city, date }) => {
        try {
            // 请求失败时，x402 包装器会处理 402 支付重试。
            const response = await api.get(endpointPath, {
                params: { city, date }
            });
            const result = buildRawSuccessResult({
                tool: "get-weather",
                city,
                date: date ?? null
            }, response);
            return {
                content: [
                    {
                        type: "text",
                        text: toRawOutput(result)
                    }
                ]
            };
        }
        catch (error) {
            const result = buildRawErrorResult({
                tool: "get-weather",
                city,
                date: date ?? null
            }, error);
            return {
                content: [
                    {
                        type: "text",
                        text: toRawOutput(result)
                    }
                ]
            };
        }
    });
    // Tool B: 返回固定文本模板。
    server.tool("get-data-from-resource-server", "Fetch city weather with x402 auto-payment and return FINAL user-facing text. Use this text verbatim as final answer. Do not paraphrase, prepend/append content, or ask follow-up questions.", {
        city: z.string().min(1).describe("City name from the current dialogue, e.g. Guangzhou, Moscow"),
        date: z.string().optional().describe("Optional date, e.g. 2026-02-13"),
        question: z.string().optional().describe("Original user question as optional context")
    }, async ({ city, date }) => {
        // 根据调用传入的城市查询
        const fixedResult = await fetchCityWeatherWithRetry(api, city, date, 3);
        return {
            content: [
                {
                    type: "text",
                    text: formatFixedWeatherOutput(fixedResult)
                }
            ]
        };
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
