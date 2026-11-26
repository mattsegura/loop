// Production in-memory metrics collector for Loop Gateway (/metrics).
// Zero external dependencies; tracks bounded ring-buffer latency histograms (p50/p95/p99)
// and monotonic counters exported as JSON or Prometheus text exposition format 0.0.4.

const MAX_SAMPLES = 1000;

class LatencyRing {
  constructor(max = MAX_SAMPLES) {
    this.max = max;
    this.samples = [];
    this.count = 0;
    this.sum = 0;
  }

  observe(ms) {
    const val = Number(ms);
    if (!Number.isFinite(val) || val < 0) return;
    this.count += 1;
    this.sum += val;
    if (this.samples.length < this.max) {
      this.samples.push(val);
    } else {
      this.samples[(this.count - 1) % this.max] = val;
    }
  }

  summary() {
    if (this.samples.length === 0) {
      return { count: this.count, sumMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
    return {
      count: this.count,
      sumMs: Math.round(this.sum * 100) / 100,
      p50Ms: Math.round(pick(0.5) * 100) / 100,
      p95Ms: Math.round(pick(0.95) * 100) / 100,
      p99Ms: Math.round(pick(0.99) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
  }
}

export class MetricsCollector {
  constructor({ gaugesProvider = null } = {}) {
    this.startedAt = Date.now();
    this.gaugesProvider = typeof gaugesProvider === 'function' ? gaugesProvider : null;
    this.counters = {
      http_requests_total: 0,
      http_errors_total: 0,
      mcp_requests_total: 0,
      mcp_tool_calls_total: 0,
      mcp_tool_errors_total: 0,
      oauth_refresh_failures_total: 0,
      workspaces_evicted_total: 0,
      webhooks_received_total: 0,
      schedules_fired_total: 0,
    };
    this.httpLatency = new LatencyRing();
    this.mcpLatency = new LatencyRing();
  }

  inc(name, delta = 1) {
    if (Object.hasOwn(this.counters, name)) {
      this.counters[name] += Number(delta) || 0;
    }
  }

  observeHttp(ms, statusCode = 200) {
    this.inc('http_requests_total', 1);
    if (Number(statusCode) >= 500) this.inc('http_errors_total', 1);
    this.httpLatency.observe(ms);
  }

  observeMcpTool(ms, ok = true) {
    this.inc('mcp_tool_calls_total', 1);
    if (!ok) this.inc('mcp_tool_errors_total', 1);
    this.mcpLatency.observe(ms);
  }

  _gauges() {
    const extra = this.gaugesProvider ? (this.gaugesProvider() || {}) : {};
    const mem = process.memoryUsage();
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      process_resident_memory_bytes: mem.rss,
      process_heap_used_bytes: mem.heapUsed,
      active_workspaces: Number(extra.activeWorkspaces) || 0,
      pending_approvals: Number(extra.pendingApprovals) || 0,
    };
  }

  toJson() {
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      counters: { ...this.counters },
      gauges: this._gauges(),
      latency: {
        http: this.httpLatency.summary(),
        mcpTool: this.mcpLatency.summary(),
      },
    };
  }

  toPrometheus() {
    const lines = [];
    for (const [k, v] of Object.entries(this.counters)) {
      lines.push(`# TYPE loop_${k} counter`);
      lines.push(`loop_${k} ${v}`);
    }
    const gauges = this._gauges();
    for (const [k, v] of Object.entries(gauges)) {
      lines.push(`# TYPE loop_${k} gauge`);
      lines.push(`loop_${k} ${v}`);
    }
    const http = this.httpLatency.summary();
    lines.push('# TYPE loop_http_request_duration_ms summary');
    lines.push(`loop_http_request_duration_ms{quantile="0.5"} ${http.p50Ms}`);
    lines.push(`loop_http_request_duration_ms{quantile="0.95"} ${http.p95Ms}`);
    lines.push(`loop_http_request_duration_ms{quantile="0.99"} ${http.p99Ms}`);
    lines.push(`loop_http_request_duration_ms_sum ${http.sumMs}`);
    lines.push(`loop_http_request_duration_ms_count ${http.count}`);

    const mcp = this.mcpLatency.summary();
    lines.push('# TYPE loop_mcp_tool_duration_ms summary');
    lines.push(`loop_mcp_tool_duration_ms{quantile="0.5"} ${mcp.p50Ms}`);
    lines.push(`loop_mcp_tool_duration_ms{quantile="0.95"} ${mcp.p95Ms}`);
    lines.push(`loop_mcp_tool_duration_ms{quantile="0.99"} ${mcp.p99Ms}`);
    lines.push(`loop_mcp_tool_duration_ms_sum ${mcp.sumMs}`);
    lines.push(`loop_mcp_tool_duration_ms_count ${mcp.count}`);

    return `${lines.join('\n')}\n`;
  }
}
