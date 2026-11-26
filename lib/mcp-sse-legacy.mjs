// Legacy MCP 2024-11-05 HTTP+SSE transport adapter.
// Bridges GET /sse (endpoint announcement + server-to-client message stream) and
// POST /messages?sessionId=<id> (202 Accepted, response pushed on the SSE stream)
// into Loop's standard handleMcpRequest pipeline so all policies, Vault masking,
// approvals, and audit logging apply identically.

import { randomBytes } from 'node:crypto';

const MAX_LEGACY_STREAMS = 200;
const HEARTBEAT_MS = 25_000;

export class LegacyMcpSseManager {
  constructor({ maxStreams = MAX_LEGACY_STREAMS, heartbeatMs = HEARTBEAT_MS } = {}) {
    this.maxStreams = Math.max(1, Number(maxStreams) || MAX_LEGACY_STREAMS);
    this.heartbeatMs = Math.max(1000, Number(heartbeatMs) || HEARTBEAT_MS);
    this.streams = new Map();
    this.closed = false;
  }

  openStream(req, res, { agentId = null, sessionId = null, messagePath = '/messages', profile = null, role = null, actor = null } = {}) {
    if (this.closed) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Server is shutting down.' }));
      return null;
    }
    if (this.streams.size >= this.maxStreams) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Too many active SSE streams.' }));
      return null;
    }

    const streamId = `sse_${randomBytes(16).toString('hex')}`;
    const query = new URLSearchParams({ sessionId: streamId });
    if (profile) query.set('profile', profile);
    if (role) query.set('role', role);
    const endpointUrl = `${messagePath}?${query.toString()}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    });
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    const entry = {
      id: streamId,
      res,
      agentId: agentId ?? null,
      sessionId: sessionId ?? null,
      profile,
      role,
      actor,
      createdAt: Date.now(),
      heartbeat: null,
    };

    entry.heartbeat = setInterval(() => {
      if (this.closed || res.writableEnded || res.destroyed) {
        this.remove(streamId);
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        this.remove(streamId);
        try { res.end(); } catch { /* ignore */ }
      }
    }, this.heartbeatMs);
    entry.heartbeat.unref?.();

    this.streams.set(streamId, entry);
    const cleanup = () => this.remove(streamId);
    req.on('close', cleanup);
    res.on('close', cleanup);
    return entry;
  }

  getStream(streamId, agentId = null) {
    if (typeof streamId !== 'string' || !streamId) return null;
    const entry = this.streams.get(streamId);
    if (!entry) return null;
    if (entry.agentId !== (agentId ?? null)) return null;
    if (entry.res.writableEnded || entry.res.destroyed) {
      this.remove(streamId);
      return null;
    }
    return entry;
  }

  pushMessage(streamId, agentId, payload) {
    const entry = this.getStream(streamId, agentId);
    if (!entry) return false;
    try {
      entry.res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      this.remove(streamId);
      return false;
    }
  }

  remove(streamId) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    this.streams.delete(streamId);
  }

  closeAll() {
    this.closed = true;
    for (const [id, entry] of this.streams.entries()) {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      try { entry.res.end(); } catch { /* ignore */ }
      this.streams.delete(id);
    }
  }
}
