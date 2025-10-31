import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";  // Changed from V2
import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const TABLE_POLLS = process.env.TABLE_POLLS!;
const TABLE_VOTERS = process.env.TABLE_VOTERS!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",");
const ENVIRONMENT = process.env.NODE_ENV || "dev";

const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY;

function response(
    status: number,
    body: any,
    origin?: string
): APIGatewayProxyResult {  // Changed from V2
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
    }
    return {
        statusCode: status,
        headers,
        body: JSON.stringify(body),
    };
}

function parseClientIp(event: APIGatewayProxyEvent): string {  // Changed from V2
    return (
        event.requestContext.identity?.sourceIp ||  // Changed from http.sourceIp
        event.headers["x-forwarded-for"]?.split(",")[0] ||
        "unknown"
    );
}

export const handler = async (
    event: APIGatewayProxyEvent  // Changed from V2
): Promise<APIGatewayProxyResult> => {  // Changed from V2
    const origin = event.headers?.origin || event.headers?.Origin;
    const method = event.httpMethod;  // Changed from event.requestContext.http.method
    const path = event.path;  // Changed from event.rawPath

    // CORS preflight
    if (method === "OPTIONS") {
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": origin || "*",
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, x-api-key",
            },
            body: "",
        };
    }

    // --- Basic API key validation ---
    const clientKey = event.headers["x-api-key"];
    if (!clientKey) {
        return response(401, { error: "Missing API key" }, origin);
    }

    try {
        // -----------------------
        // RESULTS (GET /results)
        // -----------------------
        if (method === "GET" && path.includes("results")) {
            const params = event.queryStringParameters || {};
            const pollId = params["pollId"];
            const voterToken = params["voterToken"];

            if (!pollId) return response(400, { error: "Missing pollId" }, origin);

            const pollResp = await ddb.send(
                new GetCommand({
                    TableName: TABLE_POLLS,
                    Key: { pollId },
                })
            );

            const poll = pollResp.Item;
            if (!poll) return response(404, { error: "Poll not found" }, origin);

            const options =
                typeof poll.options === "string"
                    ? JSON.parse(poll.options)
                    : poll.options;

            const showVoteCount = String(poll.showVoteCount) !== "false";
            let hasVoted = false;

            if (voterToken) {
                const voterResp = await ddb.send(
                    new GetCommand({
                        TableName: TABLE_VOTERS,
                        Key: { pollId, voterToken },
                    })
                );
                hasVoted = !!voterResp.Item;
            }

            const totalVotes = options.reduce(
                (sum: number, o: any) => sum + (o.votes || 0),
                0
            );

            return response(
                200,
                {
                    question: poll.question,
                    options,
                    totalVotes,
                    hasVoted,
                    status: poll.status || "active",
                    isClosed: poll.status === "closed",
                    showVoteCount,
                },
                origin
            );
        }

        // -----------------------
        // VOTE (POST /vote)
        // -----------------------
        if (method === "POST" && path.includes("vote")) {
            if (!event.body)
                return response(400, { error: "Missing body" }, origin);

            const { pollId, optionId, voterToken } = JSON.parse(event.body);
            if (!pollId || optionId === undefined || !voterToken)
                return response(400, { error: "Missing params" }, origin);

            const clientIp = parseClientIp(event);
            console.log(`Vote from ${clientIp}`);

            const pollResp = await ddb.send(
                new GetCommand({
                    TableName: TABLE_POLLS,
                    Key: { pollId },
                })
            );
            const poll = pollResp.Item;
            if (!poll) return response(404, { error: "Poll not found" }, origin);
            if (poll.status === "closed")
                return response(403, { error: "Poll is closed" }, origin);

            const options =
                typeof poll.options === "string"
                    ? JSON.parse(poll.options)
                    : poll.options;

            if (!options[optionId])
                return response(400, { error: "Invalid option" }, origin);

            const existingVote = await ddb.send(
                new GetCommand({
                    TableName: TABLE_VOTERS,
                    Key: { pollId, voterToken },
                })
            );
            if (existingVote.Item)
                return response(400, { error: "Already voted" }, origin);

            options[optionId].votes = (options[optionId].votes || 0) + 1;

            await ddb.send(
                new UpdateCommand({
                    TableName: TABLE_POLLS,
                    Key: { pollId },
                    UpdateExpression: "SET #o = :o",
                    ExpressionAttributeNames: { "#o": "options" },
                    ExpressionAttributeValues: { ":o": JSON.stringify(options) },
                })
            );

            await ddb.send(
                new PutCommand({
                    TableName: TABLE_VOTERS,
                    Item: { pollId, voterToken },
                })
            );

            const totalVotes = options.reduce(
                (sum: number, o: any) => sum + (o.votes || 0),
                0
            );

            return response(
                200,
                {
                    success: true,
                    poll: {
                        question: poll.question,
                        options,
                        totalVotes,
                        showVoteCount: String(poll.showVoteCount) !== "false",
                    },
                },
                origin
            );
        }

        return response(404, { error: "Not found" }, origin);
    } catch (err) {
        console.error("Error:", err);
        return response(500, { error: "Internal server error" }, origin);
    }
};