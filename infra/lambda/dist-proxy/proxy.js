"use strict";

// proxy.ts
var TARGET_API_BASE = process.env.TARGET_API_BASE;
var PUBLIC_API_KEY = process.env.PUBLIC_API_KEY;
var ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",");
function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true"
  };
  if (origin) {
    try {
      const url = new URL(origin);
      const normalized = `${url.protocol}//${url.hostname}`;
      if (ALLOWED_ORIGINS.includes(normalized)) {
        headers["Access-Control-Allow-Origin"] = origin;
      } else {
        console.warn(`CORS rejected origin: ${origin}`);
      }
    } catch (err) {
      console.error("CORS invalid origin:", origin, err);
    }
  }
  if (!headers["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGINS[0] || "*";
  }
  return headers;
}
exports.handler = async (event) => {
  if (event.warmup) {
    console.log("Proxy warmup ping received");
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "proxy warm" })
    };
  }
  console.log("=== PROXY INVOKED ===");
  console.log("Environment variables:", {
    TARGET_API_BASE: TARGET_API_BASE || "[MISSING]",
    PUBLIC_API_KEY: PUBLIC_API_KEY ? "[SET]" : "[MISSING]",
    ALLOWED_ORIGINS
  });
  console.log("Event:", JSON.stringify(event, null, 2));
  const origin = event.headers.origin || event.headers.Origin;
  if (event.httpMethod === "OPTIONS") {
    console.log("Handling OPTIONS preflight");
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: ""
    };
  }
  if (!TARGET_API_BASE || !PUBLIC_API_KEY) {
    console.error("CRITICAL: Missing required environment variables!");
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        error: "Configuration error",
        details: {
          TARGET_API_BASE: TARGET_API_BASE ? "set" : "missing",
          PUBLIC_API_KEY: PUBLIC_API_KEY ? "set" : "missing"
        }
      })
    };
  }
  try {
    const forwardPath = event.pathParameters?.proxy ? `/${event.pathParameters.proxy}` : "";
    const queryString = event.queryStringParameters ? "?" + Object.entries(event.queryStringParameters).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`).join("&") : "";
    const targetUrl = `${TARGET_API_BASE}${forwardPath}${queryString}`;
    console.log("Forwarding request:", {
      method: event.httpMethod,
      targetUrl,
      hasBody: !!event.body
    });
    const resp = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PUBLIC_API_KEY
      },
      body: event.httpMethod === "GET" ? void 0 : event.body
    });
    console.log("Target API response:", {
      status: resp.status,
      statusText: resp.statusText
    });
    const body = await resp.text();
    console.log("Response body length:", body.length);
    if (body.length < 500) {
      console.log("Response body:", body);
    } else {
      console.log("Response body preview:", body.substring(0, 200) + "...");
    }
    return {
      statusCode: resp.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      },
      body
    };
  } catch (error) {
    console.error("Proxy error:", error);
    console.error("Error stack:", error.stack);
    return {
      statusCode: 502,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        error: "Proxy failed",
        message: error.message,
        type: error.constructor.name
      })
    };
  }
};
