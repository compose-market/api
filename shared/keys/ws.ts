/**
 * WebSocket Handler for Session Events
 * 
 * Real-time session expiration notifications via WebSocket.
 * 
 * @module shared/keys/ws
 */

import type {
    APIGatewayProxyEvent as WsEvent,
    APIGatewayProxyResult as WsResult,
    Context,
} from "aws-lambda";
import {
    redisSet,
    redisGet,
    redisDel,
    redisSAdd,
    redisSRem,
    redisSMembers,
} from "../configs/redis.js";

const CONN_TTL = 3600;
const CONN_KEY = "ws:conn:";
const SUB_KEY = "ws:sub:";

interface SubMsg {
    action: "subscribe";
    userAddress: string;
    chainId: number;
}

interface UnsubMsg {
    action: "unsubscribe";
    userAddress: string;
    chainId: number;
}

type ClientMsg = SubMsg | UnsubMsg | { action: "ping" };

export async function wsHandler(
    event: WsEvent,
    _ctx: Context
): Promise<WsResult> {
    const route = event.requestContext.routeKey;
    const connId = event.requestContext.connectionId!;
    const domain = event.requestContext.domainName!;
    const stage = event.requestContext.stage!;

    try {
        switch (route) {
            case "$connect":
                return await onConnect(connId);
            case "$disconnect":
                return await onDisconnect(connId);
            default:
                return await onMessage(connId, event.body || "", domain, stage);
        }
    } catch (err) {
        console.error(`[ws] Error:`, err);
        return { statusCode: 500, body: "Error" };
    }
}

async function onConnect(connId: string): Promise<WsResult> {
    const key = `${CONN_KEY}${connId}`;
    await redisSet(key, JSON.stringify({ at: Date.now() }), CONN_TTL);
    console.log(`[ws] Connected: ${connId}`);
    return { statusCode: 200, body: JSON.stringify({ connId, status: "connected" }) };
}

async function onDisconnect(connId: string): Promise<WsResult> {
    const key = `${CONN_KEY}${connId}`;
    const data = await redisGet(key);
    
    if (data) {
        try {
            const conn = JSON.parse(data);
            if (conn.subs) {
                for (const sub of conn.subs) {
                    await redisSRem(sub, connId);
                }
            }
        } catch {}
    }
    
    await redisDel(key);
    console.log(`[ws] Disconnected: ${connId}`);
    return { statusCode: 200, body: "OK" };
}

async function onMessage(
    connId: string,
    body: string,
    domain: string,
    stage: string
): Promise<WsResult> {
    let msg: ClientMsg;
    try {
        msg = JSON.parse(body);
    } catch {
        return { statusCode: 400, body: "Invalid JSON" };
    }

    switch (msg.action) {
        case "subscribe":
            return await onSubscribe(connId, msg);
        case "unsubscribe":
            return await onUnsubscribe(connId, msg);
        case "ping":
            return await send(connId, { action: "pong" }, domain, stage);
        default:
            return { statusCode: 400, body: "Unknown action" };
    }
}

async function onSubscribe(connId: string, msg: SubMsg): Promise<WsResult> {
    const addr = msg.userAddress.toLowerCase();
    const subKey = `${SUB_KEY}${addr}:${msg.chainId}`;
    const connKey = `${CONN_KEY}${connId}`;
    
    await redisSAdd(subKey, connId);
    
    const data = await redisGet(connKey);
    let conn: Record<string, unknown> = { at: Date.now() };
    if (data) {
        try { conn = JSON.parse(data); } catch {}
    }
    
    const subs = new Set((conn.subs as string[]) || []);
    subs.add(subKey);
    conn.subs = Array.from(subs);
    
    await redisSet(connKey, JSON.stringify(conn), CONN_TTL);
    
    console.log(`[ws] Subscribed ${connId} to ${addr}:${msg.chainId}`);
    return { statusCode: 200, body: JSON.stringify({ action: "subscribed", userAddress: addr, chainId: msg.chainId }) };
}

async function onUnsubscribe(connId: string, msg: UnsubMsg): Promise<WsResult> {
    const addr = msg.userAddress.toLowerCase();
    const subKey = `${SUB_KEY}${addr}:${msg.chainId}`;
    const connKey = `${CONN_KEY}${connId}`;
    
    await redisSRem(subKey, connId);
    
    const data = await redisGet(connKey);
    if (data) {
        try {
            const conn = JSON.parse(data);
            const subs = new Set((conn.subs as string[]) || []);
            subs.delete(subKey);
            conn.subs = Array.from(subs);
            await redisSet(connKey, JSON.stringify(conn), CONN_TTL);
        } catch {}
    }
    
    console.log(`[ws] Unsubscribed ${connId} from ${addr}:${msg.chainId}`);
    return { statusCode: 200, body: JSON.stringify({ action: "unsubscribed" }) };
}

async function send(
    connId: string,
    data: unknown,
    domain: string,
    stage: string
): Promise<WsResult> {
    const endpoint = `https://${domain}/${stage}`;
    
    try {
        const res = await fetch(`${endpoint}/@connections/${connId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        
        if (!res.ok) {
            console.error(`[ws] Send failed: ${res.status}`);
            return { statusCode: res.status, body: "Failed" };
        }
        
        return { statusCode: 200, body: "Sent" };
    } catch (err) {
        console.error(`[ws] Send error:`, err);
        return { statusCode: 500, body: "Error" };
    }
}

export async function notifyExpired(
    userAddress: string,
    chainId: number,
    domain: string,
    stage: string
): Promise<void> {
    const addr = userAddress.toLowerCase();
    const subKey = `${SUB_KEY}${addr}:${chainId}`;
    
    const connIds = await redisSMembers(subKey);
    
    if (connIds.length === 0) return;
    
    console.log(`[ws] Notifying ${connIds.length} conns of expiry for ${addr}:${chainId}`);
    
    const notify = {
        action: "session-expired",
        userAddress: addr,
        chainId,
        message: "Session expired, create a new session to use our services",
        timestamp: Date.now(),
    };
    
    for (const connId of connIds) {
        await send(connId, notify, domain, stage);
    }
    
    await redisDel(subKey);
}