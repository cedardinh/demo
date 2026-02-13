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
config();
const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
if (!evmPrivateKey && !svmPrivateKey) {
    throw new Error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY must be provided");
}
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
function extractPaymentMeta(headers) {
    const encoded = getHeaderValue(headers, "payment-response") ?? getHeaderValue(headers, "x-payment-response");
    if (!encoded) {
        return {
            paymentSuccess: false,
            transactionHash: null
        };
    }
    try {
        const decoded = decodePaymentResponseHeader(encoded);
        return {
            paymentSuccess: Boolean(decoded.success),
            transactionHash: decoded.transaction ?? null
        };
    }
    catch {
        return {
            paymentSuccess: false,
            transactionHash: null
        };
    }
}
function extractPaymentRequirementMeta(error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 402) {
        return null;
    }
    const data = error.response.data;
    const accepts = Array.isArray(data?.accepts) ? data.accepts[0] : undefined;
    return {
        reason: typeof data?.error === "string" ? data.error : null,
        payer: typeof data?.payer === "string" ? data.payer : null,
        network: typeof accepts?.network === "string" ? accepts.network : null,
        requiredAmount: typeof accepts?.maxAmountRequired === "string" ? accepts.maxAmountRequired : null,
        asset: typeof accepts?.asset === "string" ? accepts.asset : null,
        payTo: typeof accepts?.payTo === "string" ? accepts.payTo : null
    };
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return JSON.stringify({ error: "Failed to serialize response" }, null, 2);
    }
}
function pickString(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function buildWeatherPreview(weatherJson) {
    if (!weatherJson || typeof weatherJson !== "object") {
        return ["- Weather data: unavailable"];
    }
    const payload = weatherJson;
    const city = pickString(payload.city);
    const weather = pickString(payload.weather) ?? pickString(payload.condition);
    const temperature = pickString(payload.temperature) ?? pickString(payload.temp);
    const observedAt = pickString(payload.observedAt) ?? pickString(payload.timestamp);
    const error = pickString(payload.error);
    if (error) {
        return [`- Service error: ${error}`];
    }
    const lines = [];
    if (city) {
        lines.push(`- City: ${city}`);
    }
    if (weather) {
        lines.push(`- Weather: ${weather}`);
    }
    if (temperature) {
        lines.push(`- Temperature: ${temperature}`);
    }
    if (observedAt) {
        lines.push(`- Observed at: ${observedAt}`);
    }
    return lines.length > 0 ? lines : ["- Weather data: returned (see JSON below)"];
}
function formatDataResultForHumans(result) {
    const statusText = result.payment_success ? "SUCCESS" : "NOT_COMPLETED";
    const txText = result.transaction_hash ?? "N/A";
    return [
        "x402 Resource Result",
        `- payment_success: ${statusText}`,
        `- transaction_hash: ${txText}`,
        ...buildWeatherPreview(result.weather_json),
        "",
        "machine_json",
        "```json",
        safeJsonStringify(result),
        "```"
    ].join("\n");
}
function buildFriendlyError(error) {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 402) {
            const paymentMeta = extractPaymentRequirementMeta(error);
            if (paymentMeta?.reason === "insufficient_funds") {
                return "Payment failed due to insufficient funds. Fund wallet with enough token balance and retry.";
            }
            return "Payment required. Please ensure wallet has sufficient USDC and retry.";
        }
        if (status === 404) {
            return "City or endpoint not found. Please verify city name and endpoint configuration.";
        }
        if (status === 408 || error.code === "ECONNABORTED") {
            return "Request timed out. Please retry in a few seconds.";
        }
        if (status && status >= 500) {
            return "Weather service is unavailable. Please retry later.";
        }
        return `Request failed (${status ?? "unknown"}): ${error.message}`;
    }
    return error instanceof Error ? error.message : "Unknown error";
}
async function main() {
    const api = await createPaidHttpClient();
    const server = new McpServer({
        name: "x402-weather-agent",
        version: "1.0.0"
    });
    server.tool("get-weather", "Get weather for a city and optional date", {
        city: z.string().min(1).describe("City name, e.g. Beijing"),
        date: z.string().optional().describe("Optional date, e.g. 2026-02-13")
    }, async ({ city, date }) => {
        try {
            const response = await api.get(endpointPath, {
                params: { city, date }
            });
            const paymentMeta = extractPaymentMeta(response.headers);
            const payload = response.data;
            const weather = String(payload.weather ?? payload.condition ?? "unknown");
            const temperature = String(payload.temperature ?? payload.temp ?? "unknown");
            const observedAt = String(payload.observedAt ?? payload.timestamp ?? new Date().toISOString());
            const summary = `${city} ${date ? `(${date}) ` : ""}weather: ${weather}, temperature: ${temperature}.`;
            const humanText = [
                "Weather Query Result",
                `- city: ${city}`,
                `- date: ${date ?? "today"}`,
                `- weather: ${weather}`,
                `- temperature: ${temperature}`,
                `- observed_at: ${observedAt}`,
                `- payment_success: ${paymentMeta.paymentSuccess ? "SUCCESS" : "NOT_COMPLETED"}`,
                `- transaction_hash: ${paymentMeta.transactionHash ?? "N/A"}`,
                "",
                "machine_json",
                "```json",
                safeJsonStringify({
                    city,
                    date: date ?? null,
                    weather,
                    temperature,
                    observedAt,
                    paymentSuccess: paymentMeta.paymentSuccess,
                    transactionHash: paymentMeta.transactionHash,
                    summary,
                    raw: payload
                }),
                "```"
            ].join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: humanText
                    }
                ]
            };
        }
        catch (error) {
            const paymentMeta = axios.isAxiosError(error)
                ? extractPaymentMeta(error.response?.headers)
                : { paymentSuccess: false, transactionHash: null };
            const paymentRequirement = extractPaymentRequirementMeta(error);
            const machineResult = {
                city,
                date: date ?? null,
                error: buildFriendlyError(error),
                paymentSuccess: paymentMeta.paymentSuccess,
                transactionHash: paymentMeta.transactionHash,
                paymentRequirement,
                hint: "Check wallet balance, endpoint config, and city spelling."
            };
            const humanText = [
                "Weather Query Result",
                `- city: ${city}`,
                `- date: ${date ?? "today"}`,
                `- status: FAILED`,
                `- reason: ${machineResult.error}`,
                `- payment_success: ${paymentMeta.paymentSuccess ? "SUCCESS" : "NOT_COMPLETED"}`,
                `- transaction_hash: ${paymentMeta.transactionHash ?? "N/A"}`,
                "",
                "machine_json",
                "```json",
                safeJsonStringify(machineResult),
                "```"
            ].join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: humanText
                    }
                ]
            };
        }
    });
    server.tool("get-data-from-resource-server", "Fetch data from the configured resource endpoint with x402 auto-payment", {}, async () => {
        try {
            const response = await api.get(endpointPath);
            const paymentMeta = extractPaymentMeta(response.headers);
            const result = {
                payment_success: paymentMeta.paymentSuccess,
                transaction_hash: paymentMeta.transactionHash,
                weather_json: response.data
            };
            return {
                content: [
                    {
                        type: "text",
                        text: formatDataResultForHumans(result)
                    }
                ]
            };
        }
        catch (error) {
            const paymentMeta = axios.isAxiosError(error)
                ? extractPaymentMeta(error.response?.headers)
                : { paymentSuccess: false, transactionHash: null };
            const weatherJson = axios.isAxiosError(error) && error.response
                ? error.response.data
                : { error: buildFriendlyError(error) };
            const result = {
                payment_success: paymentMeta.paymentSuccess,
                transaction_hash: paymentMeta.transactionHash,
                weather_json: weatherJson
            };
            return {
                content: [
                    {
                        type: "text",
                        text: formatDataResultForHumans(result)
                    }
                ]
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
