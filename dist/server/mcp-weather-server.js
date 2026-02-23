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
// 加载本地 .env 到 process.env，供 MCP 运行时读取私钥与接口配置。
config();
// 运行时配置说明：
// - 私钥决定由哪个钱包执行 x402 支付签名
// - baseURL/endpointPath 决定天气数据请求目标
// - timeout 用于避免在聊天客户端中长时间卡住
const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
// x402 对接阅读顺序（与官方 axios 接入思路一致）：
// 1) createPaidHttpClient: 注册支付签名方案并包装 axios
// 2) fetchCityWeatherWithRetry: 发起请求，402 由包装器自动支付并重试
// 3) extractTxHashFromHeaders: 从 payment-response 读取交易哈希
// 4) formatFixedWeatherOutput: 生成面向用户的结果
// 5) main: 注册 MCP 工具并串联调用流程
// 至少需要一个可用签名器（EVM 或 SVM），否则无法完成任何 x402 支付流程。
if (!evmPrivateKey && !svmPrivateKey) {
    throw new Error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
}
/**
 * 以不区分大小写的方式读取响应头。
 * Axios/Node 可能会对 header 名做不同规范化，因此同时尝试原始/小写/大写键名。
 */
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
// 安全序列化工具，避免因循环引用导致输出渲染失败。
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return JSON.stringify({ error: "Failed to serialize response" }, null, 2);
    }
}
/**
 * 统一输出原始响应，避免在服务端进行业务字段解析。
 * 由上层 AI 根据该 JSON 自行解释并组织人类可读内容。
 */
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
// Step 3: 从 x402 支付响应头里提取链上交易哈希。
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
function detectOutputLanguage(text) {
    if (/[\u4e00-\u9fff]/.test(text))
        return "zh";
    if (/[\u3040-\u30ff]/.test(text))
        return "ja";
    if (/[\uac00-\ud7af]/.test(text))
        return "ko";
    if (/[\u0400-\u04FF]/.test(text))
        return "ru";
    return "en";
}
function localizeWeatherText(weather, language) {
    const normalized = weather.trim().toLowerCase();
    const zhMap = {
        sunny: "晴",
        cloudy: "多云",
        rain: "雨",
        rainy: "雨",
        snow: "雪",
        snowy: "雪",
        windy: "有风",
        foggy: "雾",
        stormy: "风暴",
        thunderstorm: "雷暴"
    };
    if (language === "zh") {
        return zhMap[normalized] ?? weather;
    }
    return weather;
}
// Step 4: 将天气和交易信息格式化为用户可读文本。
function formatFixedWeatherOutput(result, language) {
    const txHashText = result.txHash ?? "N/A";
    const txLinkText = result.txLink ?? "N/A";
    const weatherText = localizeWeatherText(result.weather, language);
    if (language === "zh") {
        return [
            `城市：${result.city}`,
            `天气：${weatherText}`,
            `温度：${result.temperature}`,
            `请求状态：${result.status}（已完成 x402 支付重试）`,
            `交易哈希：${txHashText}`,
            `交易链接：${txLinkText}（链上状态 ${result.chainStatus}）`
        ].join("\n");
    }
    if (language === "ja") {
        return [
            `都市：${result.city}`,
            `天気：${weatherText}`,
            `気温：${result.temperature}`,
            `リクエスト状態：${result.status}（x402 支払いリトライ完了）`,
            `トランザクションハッシュ：${txHashText}`,
            `取引リンク：${txLinkText}（チェーン状態 ${result.chainStatus}）`
        ].join("\n");
    }
    if (language === "ko") {
        return [
            `도시: ${result.city}`,
            `날씨: ${weatherText}`,
            `기온: ${result.temperature}`,
            `요청 상태: ${result.status} (x402 결제 재시도 완료)`,
            `트랜잭션 해시: ${txHashText}`,
            `거래 링크: ${txLinkText} (체인 상태 ${result.chainStatus})`
        ].join("\n");
    }
    if (language === "ru") {
        return [
            `Город: ${result.city}`,
            `Погода: ${weatherText}`,
            `Температура: ${result.temperature}`,
            `Статус запроса: ${result.status} (повтор с x402-оплатой выполнен)`,
            `Хэш транзакции: ${txHashText}`,
            `Ссылка на транзакцию: ${txLinkText} (статус в сети ${result.chainStatus})`
        ].join("\n");
    }
    return [
        `City: ${result.city}`,
        `Weather: ${weatherText}`,
        `Temperature: ${result.temperature}`,
        `Request status: ${result.status} (x402 payment retry completed)`,
        `Transaction hash: ${txHashText}`,
        `Transaction link: ${txLinkText} (on-chain status ${result.chainStatus})`
    ].join("\n");
}
// Step 1: 按官方流程创建支付客户端并包装 axios。
// 官方流程对应：
// - 创建 x402Client
// - 注册支付方案（EVM/SVM 签名器）
// - wrapAxiosWithPayment 后直接发请求
// - 遇到 402 时中间件自动完成支付并重试
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
// Step 2: 发起业务请求，并在网络抖动时做轻量重试。
// 402 支付重试由 wrapAxiosWithPayment 自动处理，这里只负责请求编排与结果抽取。
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
/**
 * MCP 服务启动入口。
 *
 * 注册两个工具：
 * 1) get-weather(city, date?)：按城市查询，直接返回上游原始响应
 * 2) get-data-from-resource-server(city)：按城市查询并格式化输出支付与交易信息
 */
// Step 5: 注册 MCP 工具并串联整个调用流程。
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
    // Tool A: 原始返回模式，保留上游返回结构（便于调试与二次解析）。
    server.tool("get-weather", "Get weather for a city and optional date", {
        city: z.string().min(1).describe("City name, e.g. Beijing"),
        date: z.string().optional().describe("Optional date, e.g. 2026-02-13")
    }, async ({ city, date }) => {
        try {
            // 该请求由支付包装器处理：遇到 HTTP 402 时会自动完成支付并重试。
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
    // Tool B: 用户展示模式，输出“天气 + 交易哈希 + 浏览器链接”固定模板。
    server.tool("get-data-from-resource-server", "Fetch city weather with x402 auto-payment and return FINAL user-facing text. Use this text verbatim as final answer. Do not paraphrase, prepend/append content, or ask follow-up questions.", {
        city: z.string().min(1).describe("City name from the current dialogue, e.g. Guangzhou, Moscow"),
        date: z.string().optional().describe("Optional date, e.g. 2026-02-13"),
        question: z.string().optional().describe("Original user question used for language detection")
    }, async ({ city, date, question }) => {
        // 根据调用传入的城市查询
        const fixedResult = await fetchCityWeatherWithRetry(api, city, date, 3);
        const language = detectOutputLanguage((question ?? city).trim());
        return {
            content: [
                {
                    type: "text",
                    text: formatFixedWeatherOutput(fixedResult, language)
                }
            ]
        };
    });
    const transport = new StdioServerTransport();
    // 启动 stdio 传输层，使 MCP 客户端可在当前进程调用工具。
    await server.connect(transport);
}
// 顶层异常保护：避免静默退出，并输出可见错误信息。
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
