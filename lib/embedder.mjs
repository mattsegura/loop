// Pluggable semantic embedding providers and int8 vector math for Loop Search.
// Zero mandatory dependencies: runs cleanly in 'none' mode when no provider is
// enabled, or loads an on-demand local runtime / Ollama / hosted HTTP embedder.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-base-en-v1.5';
export const DEFAULT_OLLAMA_MODEL = 'snowflake-arctic-embed:xs';
export const DEFAULT_HTTP_MODEL = 'text-embedding-3-small';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const VALID_EMBEDDING_PROVIDERS = Object.freeze(['off', 'auto', 'local', 'ollama', 'http']);

const LOCAL_ESTIMATED_RAM_MB = 310;
const LOCAL_ESTIMATED_DISK_MB = 540;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const MAX_HTTP_BATCH = 64;

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/* ---------------- Vector Math Primitives ---------------- */

export function l2Normalize(input) {
  const out = input instanceof Float32Array ? new Float32Array(input) : Float32Array.from(input || []);
  let normSq = 0;
  for (let i = 0; i < out.length; i += 1) {
    const v = out[i];
    normSq += v * v;
  }
  if (normSq > 0) {
    const inv = 1 / Math.sqrt(normSq);
    for (let i = 0; i < out.length; i += 1) {
      out[i] *= inv;
    }
  }
  return out;
}

export function quantizeInt8(input) {
  const norm = l2Normalize(input);
  const out = new Int8Array(norm.length);
  for (let i = 0; i < norm.length; i += 1) {
    const scaled = Math.round(norm[i] * 127);
    out[i] = scaled > 127 ? 127 : scaled < -127 ? -127 : scaled;
  }
  return out;
}

export function dotInt8Float32(int8Buf, offset, queryF32, dim) {
  let sum = 0;
  for (let d = 0; d < dim; d += 1) {
    sum += int8Buf[offset + d] * queryF32[d];
  }
  return sum / 127;
}

/* ---------------- Config Resolution ---------------- */

export function recommendedPoolingForModel(modelId) {
  const lower = String(modelId || '').toLowerCase();
  // BGE v1.5 and Snowflake Arctic Embed are officially trained and published with CLS pooling,
  // not mean pooling — matching their architecture improves discrimination and lowers noise floors.
  if (lower.includes('bge-') || lower.includes('snowflake-arctic-embed') || lower.includes('mxbai-embed')) return 'cls';
  if (lower.includes('qwen3-embedding')) return 'last_token';
  return 'mean';
}

export function recommendedMinScoreForModel(modelId) {
  const lower = String(modelId || '').toLowerCase();
  if (lower.includes('snowflake-arctic-embed')) return 0.50;
  if (lower.includes('bge-base') || lower.includes('bge-large')) return 0.48;
  if (lower.includes('bge-')) return 0.56;
  if (lower.includes('nomic-embed')) return 0.50;
  if (lower.includes('text-embedding-3')) return 0.38;
  return 0.34;
}

export function recommendedSoftMinScoreForModel(modelId) {
  const lower = String(modelId || '').toLowerCase();
  if (lower.includes('snowflake-arctic-embed')) return 0.50;
  if (lower.includes('bge-base') || lower.includes('bge-large')) return 0.48;
  if (lower.includes('bge-')) return 0.56;
  if (lower.includes('nomic-embed')) return 0.50;
  if (lower.includes('text-embedding-3')) return 0.36;
  return 0.32;
}

function needsRetrievalQueryPrefix(model) {
  const lower = String(model || '').toLowerCase();
  return lower.includes('bge-') || lower.includes('snowflake-arctic-embed');
}

// Prefixes each model family was trained with (query vs document side).
function modelPrefix(model, kind) {
  const lower = String(model || '').toLowerCase();
  const isQuery = kind === 'query';
  if (lower.includes('nomic-embed')) return isQuery ? 'search_query: ' : 'search_document: ';
  if (lower.includes('e5-') || lower.includes('/e5')) return isQuery ? 'query: ' : 'passage: ';
  if (lower.includes('embeddinggemma')) return isQuery ? 'task: search result | query: ' : 'title: none | text: ';
  if (lower.includes('qwen3-embedding')) {
    return isQuery ? 'Instruct: Given a task an AI agent needs done, retrieve the tool or skill that does it\nQuery: ' : '';
  }
  if (lower.includes('mxbai-embed')) return isQuery ? BGE_QUERY_PREFIX : '';
  return null;
}

function formatInputTexts(texts, model, kind) {
  const special = modelPrefix(model, kind);
  const prefix = special !== null ? special : kind === 'query' && needsRetrievalQueryPrefix(model) ? BGE_QUERY_PREFIX : '';
  return texts.map((t) => {
    const clean = String(t || '').replace(/\s+/g, ' ').trim();
    return prefix ? `${prefix}${clean}` : clean;
  });
}

function validateHttpUrl(raw, { loopbackOnly = false } = {}) {
  const str = String(raw || '').trim();
  if (!str) return null;
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (loopbackOnly) {
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
      return null;
    }
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function findLocalTransformersModule(runtimeDir = null) {
  const candidates = [];
  if (runtimeDir) {
    candidates.push(path.join(runtimeDir, 'node_modules', '@huggingface', 'transformers', 'package.json'));
  }
  for (const pkgPath of candidates) {
    if (existsSync(pkgPath)) {
      return path.dirname(pkgPath);
    }
  }
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@huggingface/transformers');
    if (resolved) return resolved;
  } catch {
    // Not installed in node_modules; expected for Loop's minimal default install.
  }
  return null;
}

export function resolveEmbeddingConfig(env = process.env, { dataDir = null, personal = false } = {}) {
  const rawProvider = String(env?.LOOP_EMBEDDING_PROVIDER || 'auto').trim().toLowerCase();
  const requestedProvider = VALID_EMBEDDING_PROVIDERS.includes(rawProvider) ? rawProvider : 'auto';
  const runtimeDir = String(env?.LOOP_SEARCH_RUNTIME_DIR || '').trim() ||
    (dataDir ? path.join(dataDir, 'search-runtime') : null);
  const cacheDir = String(env?.LOOP_SEARCH_MODEL_CACHE || '').trim() ||
    (dataDir ? path.join(dataDir, 'search-models') : null);
  const httpUrl = validateHttpUrl(env?.LOOP_EMBEDDING_URL, { loopbackOnly: false });
  const apiKey = String(env?.LOOP_EMBEDDING_API_KEY || '').trim() || null;
  const ollamaUrl = validateHttpUrl(env?.LOOP_OLLAMA_URL || DEFAULT_OLLAMA_URL, { loopbackOnly: true });
  const explicitModel = String(env?.LOOP_EMBEDDING_MODEL || '').trim() || null;

  if (requestedProvider === 'off') {
    return { provider: 'none', requestedProvider, reason: 'disabled_by_config', runtimeDir, cacheDir };
  }

  if (requestedProvider === 'http' || (requestedProvider === 'auto' && httpUrl)) {
    if (!httpUrl) {
      return { provider: 'none', requestedProvider, reason: 'missing_embedding_url', runtimeDir, cacheDir };
    }
    return {
      provider: 'http',
      requestedProvider,
      url: httpUrl,
      apiKey,
      model: explicitModel || DEFAULT_HTTP_MODEL,
      runtimeDir,
      cacheDir,
    };
  }

  if (requestedProvider === 'ollama') {
    if (personal) {
      return { provider: 'none', requestedProvider, reason: 'ollama_unavailable_in_hosted', runtimeDir, cacheDir };
    }
    if (!ollamaUrl) {
      return { provider: 'none', requestedProvider, reason: 'invalid_ollama_url', runtimeDir, cacheDir };
    }
    return {
      provider: 'ollama',
      requestedProvider,
      url: ollamaUrl,
      model: explicitModel || DEFAULT_OLLAMA_MODEL,
      runtimeDir,
      cacheDir,
    };
  }

  // 'local' or 'auto': only activate if the optional runtime is already present on disk.
  const localModulePath = findLocalTransformersModule(runtimeDir);
  if (localModulePath) {
    return {
      provider: 'local',
      requestedProvider,
      modulePath: localModulePath,
      model: explicitModel || DEFAULT_LOCAL_MODEL,
      dtype: String(env?.LOOP_EMBEDDING_DTYPE || 'q8').trim() || 'q8',
      runtimeDir,
      cacheDir,
    };
  }

  return {
    provider: 'none',
    requestedProvider,
    reason: requestedProvider === 'local' ? 'local_runtime_not_installed' : 'optional_addon_not_enabled',
    model: explicitModel || DEFAULT_LOCAL_MODEL,
    runtimeDir,
    cacheDir,
  };
}

/* ---------------- Provider Implementations ---------------- */

export function createNullEmbedder({ reason = 'not_configured', runtimeDir = null } = {}) {
  const installHint = runtimeDir
    ? `npm --prefix ${JSON.stringify(runtimeDir)} install @huggingface/transformers`
    : 'Configure LOOP_EMBEDDING_URL or install @huggingface/transformers into Loop search-runtime';
  return {
    provider: 'none',
    modelId: null,
    dimensions: 0,
    isAvailable() {
      return false;
    },
    async embed() {
      return null;
    },
    getInfo() {
      return {
        provider: 'none',
        modelId: null,
        dimensions: 0,
        available: false,
        loaded: false,
        reason,
        estimatedRamMb: 0,
        estimatedDiskMb: 0,
        installHint,
      };
    },
    async close() {},
  };
}

export function createCustomEmbedder({
  provider = 'custom',
  modelId = 'custom:v1',
  dimensions = 384,
  embed,
  estimatedRamMb = 0,
  recommendedMinScore = 0.34,
  recommendedSoftMinScore = null,
} = {}) {
  if (typeof embed !== 'function') {
    throw new Error('createCustomEmbedder requires an embed(texts, opts) function.');
  }
  let detectedDims = dimensions;
  let callCount = 0;
  const softScore =
    typeof recommendedSoftMinScore === 'number' && Number.isFinite(recommendedSoftMinScore)
      ? recommendedSoftMinScore
      : Math.max(0.15, Math.round((recommendedMinScore - 0.05) * 1000) / 1000);
  return {
    provider,
    modelId,
    recommendedMinScore,
    recommendedSoftMinScore: softScore,
    get dimensions() {
      return detectedDims;
    },
    isAvailable() {
      return true;
    },
    async embed(texts, opts = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      callCount += 1;
      const raw = await embed(texts, opts);
      if (!Array.isArray(raw) || raw.length !== texts.length) {
        throw new Error('Custom embedder returned mismatched vector count.');
      }
      const normalized = raw.map((v) => l2Normalize(v));
      if (normalized[0]?.length > 0) detectedDims = normalized[0].length;
      return normalized;
    },
    getInfo() {
      return {
        provider,
        modelId,
        dimensions: detectedDims,
        available: true,
        loaded: callCount > 0,
        estimatedRamMb,
        estimatedDiskMb: 0,
      };
    },
    async close() {},
  };
}

function createLocalTransformersEmbedder(cfg) {
  const pooling = recommendedPoolingForModel(cfg.model);
  const dtype = cfg.dtype || 'q8';
  const modelId = pooling === 'cls' ? `local:${cfg.model}:${dtype}:cls` : `local:${cfg.model}:${dtype}`;
  let extractorPromise = null;
  let loaded = false;
  let dimensions = 0;
  let lastError = null;

  async function loadExtractor() {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        const importTarget = existsSync(path.join(cfg.modulePath, 'package.json'))
          ? pathToFileURL(path.join(cfg.modulePath, 'dist', 'transformers.node.mjs')).href
          : pathToFileURL(cfg.modulePath).href;
        let mod;
        try {
          mod = await import(importTarget);
        } catch {
          mod = await import('@huggingface/transformers');
        }
        if (cfg.cacheDir && mod.env) {
          mod.env.cacheDir = cfg.cacheDir;
        }
        const pipe = await mod.pipeline('feature-extraction', cfg.model, {
          dtype: cfg.dtype || 'q8',
        });
        loaded = true;
        lastError = null;
        return pipe;
      })().catch((err) => {
        extractorPromise = null;
        lastError = err?.message || 'Failed to load local embedding model.';
        throw err;
      });
    }
    return extractorPromise;
  }

  return {
    provider: 'local',
    modelId,
    recommendedMinScore: recommendedMinScoreForModel(cfg.model),
    recommendedSoftMinScore: recommendedSoftMinScoreForModel(cfg.model),
    get dimensions() {
      return dimensions;
    },
    isAvailable() {
      return true;
    },
    async embed(texts, { kind = 'document' } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const pipe = await loadExtractor();
      const formatted = formatInputTexts(texts, cfg.model, kind);
      const output = await pipe(formatted, { pooling, normalize: true });
      const dims = Array.isArray(output?.dims) ? output.dims : null;
      const data = output?.data;
      if (!data || !dims || dims.length < 2) {
        throw new Error('Unexpected tensor output from local embedding model.');
      }
      const rows = dims[0];
      const dim = dims[dims.length - 1];
      dimensions = dim;
      const out = new Array(rows);
      for (let i = 0; i < rows; i += 1) {
        const slice = data.subarray(i * dim, (i + 1) * dim);
        out[i] = l2Normalize(slice);
      }
      return out;
    },
    getInfo() {
      return {
        provider: 'local',
        modelId,
        dimensions,
        available: true,
        loaded,
        estimatedRamMb: loaded ? LOCAL_ESTIMATED_RAM_MB : 0,
        estimatedRamLoadedMb: LOCAL_ESTIMATED_RAM_MB,
        estimatedDiskMb: LOCAL_ESTIMATED_DISK_MB,
        ...(lastError ? { lastError } : {}),
      };
    },
    async close() {
      if (extractorPromise) {
        try {
          const pipe = await extractorPromise;
          if (typeof pipe?.dispose === 'function') await pipe.dispose();
        } catch {
          // ignore
        }
      }
      extractorPromise = null;
      loaded = false;
    },
  };
}

function createOllamaEmbedder(cfg, { fetchImpl = fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  const modelId = `ollama:${cfg.model}`;
  let dimensions = 0;
  let loaded = false;
  let lastError = null;

  return {
    provider: 'ollama',
    modelId,
    recommendedMinScore: recommendedMinScoreForModel(cfg.model),
    recommendedSoftMinScore: recommendedSoftMinScoreForModel(cfg.model),
    get dimensions() {
      return dimensions;
    },
    isAvailable() {
      return true;
    },
    async embed(texts, { kind = 'document', signal = null } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const formatted = formatInputTexts(texts, cfg.model, kind);
      const out = [];
      for (let start = 0; start < formatted.length; start += MAX_HTTP_BATCH) {
        const chunk = formatted.slice(start, start + MAX_HTTP_BATCH);
        const timeout = AbortSignal.timeout(timeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const res = await fetchImpl(`${cfg.url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, input: chunk }),
          signal: combinedSignal,
        });
        if (!res.ok) {
          lastError = `Ollama embed failed (${res.status})`;
          throw new Error(lastError);
        }
        const json = await res.json();
        const embeddings = Array.isArray(json?.embeddings) ? json.embeddings : null;
        if (!embeddings || embeddings.length !== chunk.length) {
          lastError = 'Invalid response from Ollama embed endpoint.';
          throw new Error(lastError);
        }
        for (const vec of embeddings) {
          const norm = l2Normalize(vec);
          if (norm.length > 0) dimensions = norm.length;
          out.push(norm);
        }
      }
      loaded = true;
      lastError = null;
      return out;
    },
    getInfo() {
      return {
        provider: 'ollama',
        modelId,
        dimensions,
        available: true,
        loaded,
        estimatedRamMb: 0,
        estimatedDiskMb: 0,
        ...(lastError ? { lastError } : {}),
      };
    },
    async close() {},
  };
}

function createHttpEmbedder(cfg, { fetchImpl = fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  const modelId = `http:${cfg.model}`;
  const endpoint = /\/embeddings$/i.test(cfg.url) ? cfg.url : `${cfg.url}/v1/embeddings`;
  let dimensions = 0;
  let loaded = false;
  let lastError = null;

  return {
    provider: 'http',
    modelId,
    recommendedMinScore: recommendedMinScoreForModel(cfg.model),
    recommendedSoftMinScore: recommendedSoftMinScoreForModel(cfg.model),
    get dimensions() {
      return dimensions;
    },
    isAvailable() {
      return true;
    },
    async embed(texts, { kind = 'document', signal = null } = {}) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const formatted = formatInputTexts(texts, cfg.model, kind);
      const out = [];
      for (let start = 0; start < formatted.length; start += MAX_HTTP_BATCH) {
        const chunk = formatted.slice(start, start + MAX_HTTP_BATCH);
        const timeout = AbortSignal.timeout(timeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: cfg.model, input: chunk }),
          signal: combinedSignal,
        });
        if (!res.ok) {
          lastError = `Embedding HTTP request failed (${res.status})`;
          throw new Error(lastError);
        }
        const json = await res.json();
        const rows = Array.isArray(json?.data)
          ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
          : Array.isArray(json?.embeddings)
            ? json.embeddings
            : null;
        if (!rows || rows.length !== chunk.length) {
          lastError = 'Invalid embedding HTTP response payload.';
          throw new Error(lastError);
        }
        for (const vec of rows) {
          const norm = l2Normalize(vec);
          if (norm.length > 0) dimensions = norm.length;
          out.push(norm);
        }
      }
      loaded = true;
      lastError = null;
      return out;
    },
    getInfo() {
      return {
        provider: 'http',
        modelId,
        dimensions,
        available: true,
        loaded,
        estimatedRamMb: 0,
        estimatedDiskMb: 0,
        ...(lastError ? { lastError } : {}),
      };
    },
    async close() {},
  };
}

export function createEmbedder(config = {}, opts = {}) {
  const cfg = config?.provider ? config : resolveEmbeddingConfig(process.env, opts);
  if (cfg.provider === 'local') return createLocalTransformersEmbedder(cfg);
  if (cfg.provider === 'ollama') return createOllamaEmbedder(cfg, opts);
  if (cfg.provider === 'http') return createHttpEmbedder(cfg, opts);
  return createNullEmbedder({ reason: cfg.reason || 'not_configured', runtimeDir: cfg.runtimeDir || null });
}
