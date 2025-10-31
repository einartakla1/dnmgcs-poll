import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Load environment variables from Lambda config
const TARGET_API_BASE = process.env.TARGET_API_BASE!;
const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",");

if (!TARGET_API_BASE || !PUBLIC_API_KEY) {
    console.error("CRITICAL: Missing environment variables!", {
        TARGET_API_BASE: TARGET_API_BASE || "MISSING",
        PUBLIC_API_KEY: PUBLIC_API_KEY ? "SET" : "MISSING"
    });
    throw new Error("Missing required environment variables");
}

console.log("Loaded env:", {
    TARGET_API_BASE,
    PUBLIC_API_KEY: "[set]",
    ALLOWED_ORIGINS,
});

function corsHeaders(origin?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Credentials": "true",
    };

    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    } else {
        headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGINS[0] || "*";
    }

    return headers;
}

exports.handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    const debugInfo: any[] = [];

    try {
        debugInfo.push({ step: "start", timestamp: new Date().toISOString() });

        const origin = event.headers.origin || event.headers.Origin;
        debugInfo.push({ step: "origin", value: origin });

        if (event.httpMethod === "OPTIONS") {
            return {
                statusCode: 200,
                headers: corsHeaders(origin),
                body: JSON.stringify({ debug: debugInfo, type: "OPTIONS" }),
            };
        }

        const forwardPath = event.pathParameters?.proxy
            ? `/${event.pathParameters.proxy}`
            : '';
        debugInfo.push({ step: "forwardPath", value: forwardPath });

        const queryString = event.queryStringParameters
            ? "?" + Object.entries(event.queryStringParameters)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
                .join("&")
            : "";
        debugInfo.push({ step: "queryString", value: queryString });

        const targetUrl = `${TARGET_API_BASE}${forwardPath}${queryString}`;
        debugInfo.push({ step: "targetUrl", value: targetUrl });

        const resp = await fetch(targetUrl, {
            method: event.httpMethod,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": PUBLIC_API_KEY,
            },
            body: event.httpMethod === "GET" ? undefined : event.body,
        });

        debugInfo.push({ step: "fetchComplete", status: resp.status });

        const body = await resp.text();
        debugInfo.push({ step: "bodyReceived", length: body.length });

        return {
            statusCode: resp.status,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(origin),
            },
            body: JSON.stringify({
                debug: debugInfo,
                originalResponse: body,
                targetApiStatus: resp.status
            }),
        };
    } catch (error) {
        debugInfo.push({
            step: "error",
            message: (error as Error).message,
            stack: (error as Error).stack
        });

        return {
            statusCode: 502,
            headers: corsHeaders(),
            body: JSON.stringify({
                error: "Proxy failed",
                debug: debugInfo,
                details: (error as Error).message,
            }),
        };
    }
};