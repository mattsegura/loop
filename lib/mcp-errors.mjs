// Unified structured error envelope for Loop MCP tool calls.
// Every error carries a consistent shape: code, status, message, retryable, mayHaveWritten,
// phase, recovery { action, instructions }, and a call reference ID that matches ActivityLog.

export function buildStructuredError({
  code = 'TOOL_ERROR',
  status = 500,
  message = 'Tool execution failed.',
  retryable = false,
  mayHaveWritten = false,
  phase = 'execute',
  recovery = null,
  reference = null,
  details = null,
} = {}) {
  const cleanMessage = String(message || 'Tool execution failed.').slice(0, 1000);
  const resolvedRecovery = recovery || (
    mayHaveWritten
      ? {
          action: 'inspect_upstream',
          instructions: 'Do not repeat this write automatically. Check the upstream service first to see whether the action already succeeded.',
        }
      : retryable
        ? {
            action: 'retry',
            instructions: 'This failure looks transient and the tool is marked read-only (per the upstream server). You may retry after a brief pause.',
          }
        : {
            action: 'fix_input_or_ask_user',
            instructions: 'Do not repeat the same call unchanged. Check the error message and adjust arguments or ask the user.',
          }
  );
  return {
    error: cleanMessage,
    code: String(code || 'TOOL_ERROR'),
    status: Number.isInteger(status) ? status : 500,
    message: cleanMessage,
    retryable: Boolean(retryable),
    mayHaveWritten: Boolean(mayHaveWritten),
    phase: String(phase || 'execute'),
    recovery: resolvedRecovery,
    ...(reference ? { reference: String(reference) } : {}),
    ...(details && typeof details === 'object' ? { details } : {}),
  };
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

// Codes that only Loop's own code sets on an error. An error with one of these keeps its code and
// its own recovery text. A code or a recovery text from an outside server is never passed on.
const LOOP_ERROR_CODES = new Set(['INVALID_INPUT', 'SEARCH_BLOCKED', 'UNSUPPORTED_CONTENT', 'NOT_SUPPORTED_HERE']);

/**
 * An error for input that the caller must change before it calls again. Loop reports it as
 * INVALID_INPUT and never as a fault of the service, so an agent does not send the same call again.
 */
export function inputError(message, extra = {}) {
  return Object.assign(new Error(String(message || 'Invalid input.')), { status: 400, code: 'INVALID_INPUT', ...extra });
}

/**
 * An error of Loop itself with one of Loop's codes (see LOOP_ERROR_CODES), a status, and an optional
 * recovery { action, instructions } that the agent reads.
 */
export function loopError(message, { code, status = 409, recovery = null, ...extra } = {}) {
  if (!LOOP_ERROR_CODES.has(code)) throw new Error(`Unknown Loop error code "${code}".`);
  return Object.assign(new Error(String(message || 'Loop could not do this.')), { status, code, ...(recovery ? { recovery } : {}), ...extra });
}

/**
 * Says what kind of failure a thrown error is. `network` is true when the caller already knows that
 * the server could not be reached.
 *
 * An error that carries no status and shows no sign of a network fault is NOT "the service is down".
 * It is most often an input that the tool refused or a rule of Loop. It gets the status 500 and the
 * code UPSTREAM_ERROR, and it is not retryable: only a timeout, a rate limit or a server that did not
 * answer is transient. An explicit 4xx status (not 408 or 429) is stronger than any word in the message.
 */
export function classifyUpstreamError(err, { isReadOnly = false, reference = null, network = false } = {}) {
  const msg = String(err?.message || 'Upstream tool call failed.');
  const hasStatus = Number.isInteger(err?.status);
  const clientFault = hasStatus && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  const netCode = [err?.code, err?.cause?.code].some((c) => typeof c === 'string' && NETWORK_CODES.has(c));
  const aborted = err?.name === 'AbortError' || (!clientFault && /abort|cancel/i.test(msg));
  const timedOut = !clientFault && (/timed?\s*out|ETIMEDOUT|timeout/i.test(msg) || err?.status === 504 || err?.status === 408);
  const rateLimited = err?.status === 429 || (!clientFault && /rate limit|too many requests/i.test(msg));
  const unreachable = !clientFault && (Boolean(network) || netCode || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg));
  const status = hasStatus ? err.status : timedOut ? 504 : unreachable ? 502 : 500;
  const unavailable = !clientFault && (status === 503 || status === 502 || unreachable || /\bunavailable\b/i.test(msg));
  const transient = timedOut || rateLimited || unavailable;
  const loopCode = typeof err?.code === 'string' && LOOP_ERROR_CODES.has(err.code) ? err.code : null;
  const invalidInput = !transient && !aborted && (status === 400 || status === 422 || loopCode === 'INVALID_INPUT');
  const mayHaveWritten = !isReadOnly && !invalidInput && !loopCode && (timedOut || aborted || status >= 500 || /socket hang up|ECONNRESET/i.test(msg));
  const code = loopCode && !aborted
    ? loopCode
    : aborted
      ? 'CALL_CANCELLED'
      : timedOut
        ? 'UPSTREAM_TIMEOUT'
        : rateLimited
          ? 'UPSTREAM_RATE_LIMITED'
          : unavailable
            ? 'UPSTREAM_UNAVAILABLE'
            : invalidInput
              ? 'INVALID_INPUT'
              : 'UPSTREAM_ERROR';
  const ownRecovery = loopCode && err?.recovery && typeof err.recovery === 'object' ? err.recovery : null;
  return buildStructuredError({
    code,
    status,
    message: msg,
    // A Loop error says by itself if a later call can work (retryable: true on the error).
    retryable: loopCode ? Boolean(err?.retryable) : Boolean(isReadOnly && transient && !aborted),
    mayHaveWritten,
    phase: 'upstream',
    reference,
    ...(ownRecovery ? { recovery: ownRecovery } : {}),
  });
}

export function structuredErrorResult(opts) {
  const payload = buildStructuredError(opts);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
