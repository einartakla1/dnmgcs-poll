import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Load environment variables (but don't throw yet)
const TARGET_API_BASE = process.env.TARGET_API_BASE;
const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",");

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
    // Log everything for debugging
    console.log("=== PROXY INVOKED ===");
    console.log("Environment variables:", {
        TARGET_API_BASE: TARGET_API_BASE || "[MISSING]",
        PUBLIC_API_KEY: PUBLIC_API_KEY ? "[SET]" : "[MISSING]",
        ALLOWED_ORIGINS,
    });
    console.log("Event:", JSON.stringify(event, null, 2));

    const origin = event.headers.origin || event.headers.Origin;

    // Handle OPTIONS preflight
    if (event.httpMethod === "OPTIONS") {
        console.log("Handling OPTIONS preflight");
        return {
            statusCode: 200,
            headers: corsHeaders(origin),
            body: "",
        };
    }

    // Validate environment variables at runtime
    if (!TARGET_API_BASE || !PUBLIC_API_KEY) {
        console.error("CRITICAL: Missing required environment variables!");
        return {
            statusCode: 500,
            headers: corsHeaders(origin),
            body: JSON.stringify({
                error: "Configuration error",
                details: {
                    TARGET_API_BASE: TARGET_API_BASE ? "set" : "missing",
                    PUBLIC_API_KEY: PUBLIC_API_KEY ? "set" : "missing",
                }
            }),
        };
    }

    try {
        // Build target URL
        const forwardPath = event.pathParameters?.proxy
            ? `/${event.pathParameters.proxy}`
            : '';

        const queryString = event.queryStringParameters
            ? "?" + Object.entries(event.queryStringParameters)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
                .join("&")
            : "";

        const targetUrl = `${TARGET_API_BASE}${forwardPath}${queryString}`;

        console.log("Forwarding request:", {
            method: event.httpMethod,
            targetUrl,
            hasBody: !!event.body,
        });

        // Forward to target API
        const resp = await fetch(targetUrl, {
            method: event.httpMethod,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": PUBLIC_API_KEY,
            },
            body: event.httpMethod === "GET" ? undefined : event.body,
        });

        console.log("Target API response:", {
            status: resp.status,
            statusText: resp.statusText,
        });

        const body = await resp.text();
        console.log("Response body length:", body.length);

        // Log first 200 chars for debugging (don't log full response in prod)
        if (body.length < 500) {
            console.log("Response body:", body);
        } else {
            console.log("Response body preview:", body.substring(0, 200) + "...");
        }

        // Forward the response as-is
        return {
            statusCode: resp.status,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(origin),
            },
            body: body,
        };
    } catch (error) {
        console.error("Proxy error:", error);
        console.error("Error stack:", (error as Error).stack);

        return {
            statusCode: 502,
            headers: corsHeaders(origin),
            body: JSON.stringify({
                error: "Proxy failed",
                message: (error as Error).message,
                type: (error as Error).constructor.name,
            }),
        };
    }
};