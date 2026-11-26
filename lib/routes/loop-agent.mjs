// Owner-authenticated HTTP and SSE routes for the built-in Loop Specialist agent (/api/loop-agent/*).

import { randomBytes } from 'node:crypto';
import { readJsonBody, sendJson } from '../http/transport.mjs';
import { createRedactor } from '../secret-refs.mjs';
import {
  ALL_RUNNER_IDS,
  BUILTIN_API_PROVIDERS,
  RUNNER_META,
  detectLocalClis,
  normalizeMausbotEndpoint,
  runApiAgentLoop,
  runClaudeCli,
  runCodexCli,
  runMausbot,
  vaultKeyForRunner,
} from '../loop-agent-runners.mjs';
import {
  LOOP_SPECIALIST_PROMPT_VERSION,
  buildSpecialistSystemPrompt,
} from '../loop-agent-prompt.mjs';

function sendSse(res, event, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function collectSecretValues(vault, extra = []) {
  const values = [];
  for (const s of extra) {
    if (typeof s === 'string' && s.length >= 6) values.push(s);
  }
  if (vault) {
    try {
      const items = await vault.list({ includeInternal: true });
      for (const item of items.slice(0, 250)) {
        const val = await vault.get(item.key).catch(() => null);
        if (typeof val === 'string' && val.length >= 6) values.push(val);
      }
    } catch {
      // Ignore vault read failures.
    }
  }
  return values;
}

async function listNonInternalVaultKeys(vault) {
  if (!vault) return [];
  try {
    const items = await vault.list({ includeInternal: false });
    return items.map((m) => m.key).filter((k) => typeof k === 'string' && k && !k.startsWith('__'));
  } catch {
    return [];
  }
}

async function readBody(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    sendJson(res, err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err?.publicMessage || 'Invalid JSON body.' });
    return null;
  }
}

export function createLoopAgentHandler({
  hosted = false,
  env = process.env,
  detectClisImpl = detectLocalClis,
  runnerImpls = {},
} = {}) {
  const activeRuns = new Map(); // runId -> { ac, threadId }

  async function buildCapabilities({ loopAgentStore, vault, isHosted = hosted }) {
    const cfg = loopAgentStore.getConfig();
    const envMausbotUrl = normalizeMausbotEndpoint(env?.LOOP_MAUSBOT_URL || '', { allowLoopback: !isHosted });
    const envMausbotToken = typeof env?.LOOP_MAUSBOT_TOKEN === 'string' ? env.LOOP_MAUSBOT_TOKEN.trim() : '';
    const storedMausbotUrl = normalizeMausbotEndpoint(cfg.mausbotEndpoint || '', { allowLoopback: !isHosted });
    const effectiveMausbotUrl = storedMausbotUrl || envMausbotUrl || '';
    const vaultMausbotKey = vault ? await vault.get(vaultKeyForRunner('mausbot')).catch(() => null) : null;
    const hasMausbotKey = Boolean(vaultMausbotKey || envMausbotToken);
    const mausbotAvailable = Boolean(effectiveMausbotUrl);

    const enabled = !isHosted || mausbotAvailable;
    const clis = isHosted ? { claude: null, codex: null } : detectClisImpl({ env });

    const runners = [];
    if (!isHosted) {
      for (const id of ['claude-cli', 'codex-cli']) {
        const meta = RUNNER_META[id];
        const bin = id === 'claude-cli' ? clis.claude : clis.codex;
        runners.push({
          id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          kind: meta.kind,
          available: Boolean(bin),
          model: cfg.models[id] ?? meta.defaultModel,
          effort: cfg.efforts[id] ?? meta.defaultEffort,
          models: meta.models,
          efforts: meta.efforts,
        });
      }
    }

    runners.push({
      id: 'mausbot',
      label: cfg.mausbotLabel || RUNNER_META.mausbot.label,
      shortLabel: cfg.mausbotLabel || RUNNER_META.mausbot.shortLabel,
      kind: 'bridge',
      available: mausbotAvailable,
      model: '',
      effort: '',
      models: [],
      efforts: [],
    });

    if (!isHosted) {
      for (const id of BUILTIN_API_PROVIDERS) {
        const meta = RUNNER_META[id];
        const vKey = vaultKeyForRunner(id);
        const hasKey = Boolean(vault && vKey && await vault.get(vKey).catch(() => null));
        runners.push({
          id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          kind: meta.kind,
          available: hasKey,
          hasKey,
          model: cfg.models[id] || meta.defaultModel,
          effort: cfg.efforts[id] ?? meta.defaultEffort,
          models: meta.models,
          efforts: meta.efforts,
        });
      }
    }

    const availableSet = new Set(runners.filter((r) => r.available).map((r) => r.id));
    let defaultRunner = cfg.defaultRunner && availableSet.has(cfg.defaultRunner) ? cfg.defaultRunner : '';
    if (!defaultRunner) {
      const firstReady = runners.find((r) => r.available);
      defaultRunner = firstReady ? firstReady.id : (isHosted ? 'mausbot' : 'claude-cli');
    }

    return {
      enabled,
      hosted: Boolean(isHosted),
      promptVersion: LOOP_SPECIALIST_PROMPT_VERSION,
      defaultRunner,
      runners,
      mausbot: {
        configured: mausbotAvailable,
        endpoint: effectiveMausbotUrl,
        label: cfg.mausbotLabel || 'MausBot',
        hasKey: hasMausbotKey,
        fromEnv: Boolean(!storedMausbotUrl && envMausbotUrl),
      },
    };
  }

  async function handle(req, res, {
    pathname,
    url,
    requestHosted = undefined,
    loopAgentStore,
    runTokens,
    workspaceId = 'local',
    store,
    vault,
    memoryStore,
    savedStore,
    fileStore,
    taskStore,
    library,
    deviceFolders,
    activePort,
    origin,
    mcpPath = '/mcp',
    buildBridgeMcpOpts,
    runBridgeRpc,
    broadcast,
  }) {
    if (pathname !== '/api/loop-agent' && !pathname.startsWith('/api/loop-agent/')) return false;
    if (!loopAgentStore) {
      sendJson(res, 503, { error: 'Loop Specialist is unavailable.' });
      return true;
    }

    const method = req.method;
    const isHosted = requestHosted !== undefined ? Boolean(requestHosted) : Boolean(hosted);

    // 1) Capabilities (always safe to read so the UI knows whether to show the center Loop icon)
    if (pathname === '/api/loop-agent/capabilities' || pathname === '/api/loop-agent/runners') {
      if (method === 'GET') {
        const caps = await buildCapabilities({ loopAgentStore, vault, isHosted });
        sendJson(res, 200, { ok: true, ...caps });
        return true;
      }
      if (pathname === '/api/loop-agent/runners' && method === 'PUT') {
        if (isHosted) {
          sendJson(res, 403, { error: 'Local runner settings are disabled on hosted Loop.' });
          return true;
        }
        const body = await readBody(req, res);
        if (!body) return true;

        const patch = {};
        if (body.defaultRunner !== undefined) {
          const id = String(body.defaultRunner || '').trim();
          if (id && !ALL_RUNNER_IDS.includes(id)) {
            sendJson(res, 400, { error: `Unknown runner "${id}".` });
            return true;
          }
          patch.defaultRunner = id;
        }
        if (body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
          const cleanModels = {};
          for (const [k, v] of Object.entries(body.models)) {
            if (ALL_RUNNER_IDS.includes(k)) cleanModels[k] = String(v || '').trim().slice(0, 120);
          }
          patch.models = cleanModels;
        }
        if (body.efforts && typeof body.efforts === 'object' && !Array.isArray(body.efforts)) {
          const cleanEfforts = {};
          for (const [k, v] of Object.entries(body.efforts)) {
            if (ALL_RUNNER_IDS.includes(k)) cleanEfforts[k] = String(v || '').trim().slice(0, 24);
          }
          patch.efforts = cleanEfforts;
        }

        if (body.apiKey && typeof body.apiKey === 'object') {
          const provider = String(body.apiKey.provider || '').trim().toLowerCase();
          const keyVal = typeof body.apiKey.key === 'string' ? body.apiKey.key.trim() : '';
          const vKey = vaultKeyForRunner(provider);
          if (!vKey || provider === 'mausbot') {
            sendJson(res, 400, { error: `Unsupported API provider "${provider}".` });
            return true;
          }
          if (!keyVal || keyVal.length < 6) {
            sendJson(res, 400, { error: 'Provide a valid API key.' });
            return true;
          }
          await vault.set(vKey, keyVal, {
            description: `Loop Specialist ${RUNNER_META[provider].label} key`,
            type: 'api_key',
          });
        }

        if (typeof body.removeApiKey === 'string' && body.removeApiKey.trim()) {
          const vKey = vaultKeyForRunner(body.removeApiKey.trim().toLowerCase());
          if (vKey) await vault.delete(vKey).catch(() => {});
        }

        if (body.mausbot && typeof body.mausbot === 'object') {
          if (body.mausbot.clear) {
            patch.mausbotEndpoint = '';
            await vault.delete(vaultKeyForRunner('mausbot')).catch(() => {});
          } else {
            if (body.mausbot.endpoint !== undefined) {
              const rawEp = String(body.mausbot.endpoint || '').trim();
              if (!rawEp) {
                patch.mausbotEndpoint = '';
              } else {
                const normalized = normalizeMausbotEndpoint(rawEp, { allowLoopback: !isHosted });
                if (!normalized) {
                  sendJson(res, 400, { error: 'MausBot endpoint must be an https:// URL (or loopback http://127.0.0.1 locally).' });
                  return true;
                }
                patch.mausbotEndpoint = normalized;
              }
            }
            if (body.mausbot.label !== undefined) {
              patch.mausbotLabel = String(body.mausbot.label || '').trim().slice(0, 60) || 'MausBot';
            }
            if (typeof body.mausbot.apiKey === 'string' && body.mausbot.apiKey.trim()) {
              await vault.set(vaultKeyForRunner('mausbot'), body.mausbot.apiKey.trim(), {
                description: 'Loop Specialist MausBot bearer token',
                type: 'api_key',
              });
            }
          }
        }

        loopAgentStore.updateConfig(patch);
        const caps = await buildCapabilities({ loopAgentStore, vault, isHosted });
        sendJson(res, 200, { ok: true, ...caps });
        return true;
      }
      sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT' });
      return true;
    }

    const caps = await buildCapabilities({ loopAgentStore, vault, isHosted });
    if (!caps.enabled) {
      sendJson(res, 403, { error: 'Loop Specialist chat is available on Local Loop or when MausBot is connected.' });
      return true;
    }

    // 2) Threads list / create
    if (pathname === '/api/loop-agent/threads') {
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 40;
        sendJson(res, 200, { ok: true, threads: loopAgentStore.listThreads({ limit }) });
        return true;
      }
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (!body) return true;
        const thread = loopAgentStore.createThread({
          title: body.title || 'New chat',
          project: body.project || 'all',
          runner: body.runner || caps.defaultRunner,
          model: body.model || '',
        });
        sendJson(res, 201, { ok: true, thread });
        return true;
      }
      sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      return true;
    }

    // 3) Single thread GET / PATCH / DELETE
    const threadMatch = pathname.match(/^\/api\/loop-agent\/threads\/([^/]+)$/);
    if (threadMatch) {
      let threadId;
      try { threadId = decodeURIComponent(threadMatch[1]); }
      catch { sendJson(res, 400, { error: 'Invalid thread id.' }); return true; }

      if (method === 'GET') {
        const thread = loopAgentStore.getThread(threadId);
        if (!thread) { sendJson(res, 404, { error: 'Thread not found.' }); return true; }
        sendJson(res, 200, { ok: true, thread });
        return true;
      }
      if (method === 'PATCH') {
        const body = await readBody(req, res);
        if (!body) return true;
        const updated = loopAgentStore.updateThread(threadId, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.project !== undefined ? { project: body.project } : {}),
          ...(body.runner !== undefined ? { runner: body.runner } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
        });
        if (!updated) { sendJson(res, 404, { error: 'Thread not found.' }); return true; }
        sendJson(res, 200, { ok: true, thread: updated });
        return true;
      }
      if (method === 'DELETE') {
        const deleted = loopAgentStore.deleteThread(threadId);
        if (!deleted) { sendJson(res, 404, { error: 'Thread not found.' }); return true; }
        sendJson(res, 200, { ok: true, deleted: true });
        return true;
      }
      sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' });
      return true;
    }

    // 4) Run specialist turn with live SSE stream
    const runMatch = pathname.match(/^\/api\/loop-agent\/threads\/([^/]+)\/runs$/);
    if (runMatch) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return true;
      }
      let threadId;
      try { threadId = decodeURIComponent(runMatch[1]); }
      catch { sendJson(res, 400, { error: 'Invalid thread id.' }); return true; }

      const thread = loopAgentStore.getThread(threadId);
      if (!thread) { sendJson(res, 404, { error: 'Thread not found.' }); return true; }

      const body = await readBody(req, res);
      if (!body) return true;

      const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
      if (!userMessage) {
        sendJson(res, 400, { error: 'Send a message to start a run.' });
        return true;
      }

      const chosenRunnerId = String(body.runner || thread.runner || caps.defaultRunner || '').trim();
      const runnerInfo = caps.runners.find((r) => r.id === chosenRunnerId);
      if (!runnerInfo || !runnerInfo.available) {
        sendJson(res, 400, {
          error: runnerInfo
            ? `${runnerInfo.label} is not ready yet. Connect it in runner settings or pick another runner.`
            : 'No ready runner is selected.',
          code: 'RUNNER_UNAVAILABLE',
        });
        return true;
      }

      const cfg = loopAgentStore.getConfig();
      const chosenModel = typeof body.model === 'string' && body.model.trim() !== ''
        ? body.model.trim()
        : (cfg.models[chosenRunnerId] ?? runnerInfo.model ?? '');
      const chosenEffort = typeof body.effort === 'string' && body.effort.trim() !== ''
        ? body.effort.trim()
        : (cfg.efforts[chosenRunnerId] ?? runnerInfo.effort ?? '');
      const project = String(body.project || thread.project || 'all').trim() || 'all';
      const focusedNodeId = typeof body.focusedNodeId === 'string' ? body.focusedNodeId.trim() : '';

      // Resolve project name, working folder, focused Library node, and Library counts
      const settings = await store.getSettings().catch(() => ({}));
      const profileRec = Array.isArray(settings?.profiles)
        ? settings.profiles.find((p) => p.id === project || p.name === project)
        : null;
      const projectName = project === 'all' ? 'All' : (profileRec?.name || project);
      const workingDirectory = (!isHosted && project !== 'all' && deviceFolders)
        ? (await Promise.resolve(deviceFolders.resolve(project)).catch(() => '')) || ''
        : '';

      let focusedNode = null;
      if (focusedNodeId && library) {
        const found = await library.item(focusedNodeId, { profile: project }).catch(() => null);
        if (found?.item) {
          focusedNode = {
            id: found.item.id,
            kind: found.item.kind || 'memory',
            title: found.item.title || found.item.displayTitle || found.item.name || found.item.content || found.item.id,
            content: found.item.content || found.item.note || found.item.summary || found.item.objective || '',
          };
        }
      }

      const [mems, savedList, fileList, taskList] = await Promise.all([
        memoryStore ? memoryStore.list({ profile: project }).catch(() => []) : [],
        savedStore ? savedStore.list({ profile: project, limit: 1 }).catch(() => ({ total: 0 })) : { total: 0 },
        fileStore ? fileStore.list({ profile: project, limit: 1 }).catch(() => ({ total: 0 })) : { total: 0 },
        taskStore ? taskStore.list({ profile: project }).catch(() => []) : [],
      ]);
      const libraryCounts = {
        memories: Array.isArray(mems) ? mems.length : 0,
        saved: Number(savedList?.total ?? (Array.isArray(savedList) ? savedList.length : 0)) || 0,
        files: Number(fileList?.total ?? (Array.isArray(fileList) ? fileList.length : 0)) || 0,
        tasks: Array.isArray(taskList) ? taskList.length : 0,
      };

      const systemPrompt = buildSpecialistSystemPrompt({
        projectId: project,
        projectName,
        workingDirectory,
        focusedNode,
        libraryCounts,
        hasLocalComputer: !isHosted && (chosenRunnerId === 'claude-cli' || chosenRunnerId === 'codex-cli'),
      });

      const runId = `run_${randomBytes(8).toString('hex')}`;
      const startedAt = Date.now();

      // Prepare secret redactor (includes vault keys and ephemeral run token when created)
      let issuedToken = null;
      let providerKey = '';
      if (runnerInfo.kind === 'api_key') {
        providerKey = (await vault.get(vaultKeyForRunner(chosenRunnerId)).catch(() => '')) || '';
      } else if (chosenRunnerId === 'mausbot') {
        providerKey = (await vault.get(vaultKeyForRunner('mausbot')).catch(() => ''))
          || (typeof env?.LOOP_MAUSBOT_TOKEN === 'string' ? env.LOOP_MAUSBOT_TOKEN.trim() : '');
      } else if (runnerInfo.kind === 'local_cli' && runTokens) {
        const nonInternalKeys = await listNonInternalVaultKeys(vault);
        issuedToken = runTokens.issue({
          runId,
          workspaceId,
          profile: 'all',
          ownerSession: true,
          agentName: `Loop Specialist (${runnerInfo.shortLabel})`,
          runnerKind: chosenRunnerId,
          secrets: nonInternalKeys,
        });
      }

      const secretValues = await collectSecretValues(vault, [issuedToken?.token, providerKey]);
      const redactor = createRedactor(secretValues);
      const redact = (text) => (redactor.hasSecrets ? redactor.redact(String(text ?? '')) : String(text ?? ''));
      const redactObj = (obj) => {
        if (!redactor.hasSecrets) return obj;
        try { return JSON.parse(redactor.redact(JSON.stringify(obj))); }
        catch { return obj; }
      };

      // Save user message and open run trace
      const isFirstMessage = !thread.messages || thread.messages.length === 0;
      const userMsgRecord = loopAgentStore.addMessage({
        threadId,
        role: 'user',
        text: userMessage,
        runId,
        redact,
      });
      if (isFirstMessage && thread.title === 'New chat') {
        loopAgentStore.updateThread(threadId, { title: userMessage, project, runner: chosenRunnerId, model: chosenModel });
      } else if (thread.runner !== chosenRunnerId) {
        // Switching runners resets the CLI resume session ID.
        loopAgentStore.updateThread(threadId, { project, runner: chosenRunnerId, model: chosenModel, cliSessionId: '' });
      } else {
        loopAgentStore.updateThread(threadId, { project, model: chosenModel });
      }

      const traceContext = {
        projectId: project,
        projectName,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(focusedNode ? { focusedNode } : {}),
        libraryCounts,
      };
      loopAgentStore.startRun({
        id: runId,
        threadId,
        runner: chosenRunnerId,
        model: chosenModel,
        promptVersion: LOOP_SPECIALIST_PROMPT_VERSION,
        project,
        focusedNodeId,
        context: traceContext,
        userMessage,
        redact,
      });

      const ac = new AbortController();
      activeRuns.set(runId, { ac, threadId });
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sendSse(res, 'run_start', {
        runId,
        threadId,
        runner: chosenRunnerId,
        model: chosenModel,
        promptVersion: LOOP_SPECIALIST_PROMPT_VERSION,
        userMessage: userMsgRecord,
      });

      const onEvent = (ev) => {
        sendSse(res, ev.type, redactObj(ev));
      };

      const cliSessionId = thread.runner === chosenRunnerId ? (thread.cliSessionId || '') : '';
      const validFocusProject = project && project !== 'all' && profileRec?.id ? profileRec.id : '';
      const localOrigin = activePort ? `http://127.0.0.1:${activePort}` : origin;
      const mcpUrl = `${localOrigin}${mcpPath}${validFocusProject ? `?project=${encodeURIComponent(validFocusProject)}` : ''}`;

      try {
        let outcome;
        if (chosenRunnerId === 'claude-cli') {
          const fn = runnerImpls.runClaudeCli || runClaudeCli;
          outcome = await fn({
            prompt: userMessage,
            systemPrompt,
            mcpUrl,
            runToken: issuedToken?.token || '',
            model: chosenModel,
            effort: chosenEffort,
            cwd: workingDirectory,
            sessionId: cliSessionId,
            signal: ac.signal,
            onEvent,
            env,
          });
        } else if (chosenRunnerId === 'codex-cli') {
          const fn = runnerImpls.runCodexCli || runCodexCli;
          outcome = await fn({
            prompt: userMessage,
            systemPrompt,
            mcpUrl,
            runToken: issuedToken?.token || '',
            model: chosenModel,
            effort: chosenEffort,
            cwd: workingDirectory,
            sessionId: cliSessionId,
            signal: ac.signal,
            onEvent,
            env,
          });
        } else if (chosenRunnerId === 'mausbot') {
          const fn = runnerImpls.runMausbot || runMausbot;
          const outboundMsg = focusedNode
            ? `[Loop context: Project "${projectName}", focused ${focusedNode.kind} "${focusedNode.title}" (${focusedNode.id})]\n\n${userMessage}`
            : userMessage;
          outcome = await fn({
            endpoint: caps.mausbot.endpoint,
            apiKey: providerKey,
            message: outboundMsg,
            signal: ac.signal,
            onEvent,
          });
        } else {
          const fn = runnerImpls.runApiAgentLoop || runApiAgentLoop;
          const nonInternalKeys = await listNonInternalVaultKeys(vault);
          const specialistAgent = {
            id: 'loop_specialist',
            name: `Loop Specialist (${runnerInfo.shortLabel})`,
            kind: chosenRunnerId,
            profile: 'all',
            mode: 'default',
            canManage: true,
            memoryAccess: 'read_write',
            ownerSession: true,
            enabled: true,
            secrets: nonInternalKeys,
          };
          const bridgeOpts = buildBridgeMcpOpts({
            activePort,
            origin,
            agent: specialistAgent,
            profile: 'all',
            initialProject: validFocusProject || null,
            ownerSession: true,
            role: null,
            actor: null,
            sessionId: `specialist_${threadId}`,
            signal: ac.signal,
          });
          outcome = await fn({
            provider: chosenRunnerId,
            apiKey: providerKey,
            model: chosenModel,
            systemPrompt,
            history: (thread.messages || []).map((m) => ({ role: m.role, text: m.text })),
            prompt: userMessage,
            signal: ac.signal,
            onEvent,
            listMcpTools: async () => {
              const r = await runBridgeRpc({ jsonrpc: '2.0', id: `list_${Date.now()}`, method: 'tools/list', params: {} }, bridgeOpts);
              return Array.isArray(r?.result?.tools) ? r.result.tools : [];
            },
            callMcpTool: async (name, args) => {
              const r = await runBridgeRpc(
                { jsonrpc: '2.0', id: `call_${Date.now()}`, method: 'tools/call', params: { name, arguments: args || {} } },
                bridgeOpts,
              );
              const text = r?.result?.content?.map((c) => c?.text || '').filter(Boolean).join('\n')
                || r?.error?.message
                || '';
              return { ok: !r?.error && r?.result?.isError !== true, text };
            },
          });
        }

        if (outcome.sessionId) {
          loopAgentStore.updateThread(threadId, { cliSessionId: outcome.sessionId, model: outcome.model || chosenModel });
        }

        const durationMs = Date.now() - startedAt;
        const assistantMsg = loopAgentStore.addMessage({
          threadId,
          role: 'assistant',
          text: outcome.text || 'Done.',
          runId,
          steps: outcome.steps || [],
          createdItems: outcome.createdItems || [],
          redact,
        });
        const trace = loopAgentStore.finishRun(runId, {
          status: 'completed',
          assistantReply: outcome.text || 'Done.',
          steps: outcome.steps || [],
          createdItems: outcome.createdItems || [],
          durationMs,
          model: outcome.model || chosenModel,
          redact,
        });

        // Ensure open mind-map views refresh when items were created.
        const touchedKinds = new Set((outcome.createdItems || []).map((i) => i.kind));
        if (touchedKinds.has('memory')) broadcast?.('memory');
        if (touchedKinds.has('saved')) broadcast?.('saved');
        if (touchedKinds.has('file')) broadcast?.('files');
        if (touchedKinds.has('task')) broadcast?.('tasks');

        sendSse(res, 'done', redactObj({ runId, message: assistantMsg, trace }));
      } catch (err) {
        const aborted = err?.code === 'ABORTED' || ac.signal.aborted;
        const errMsg = redact(aborted ? 'Run stopped.' : (err?.message || 'Loop Specialist run failed.'));
        const durationMs = Date.now() - startedAt;
        const trace = loopAgentStore.finishRun(runId, {
          status: aborted ? 'stopped' : 'error',
          error: errMsg,
          durationMs,
          redact,
        });
        if (!aborted) {
          loopAgentStore.addMessage({
            threadId,
            role: 'assistant',
            text: `Error: ${errMsg}`,
            runId,
            redact,
          });
        }
        sendSse(res, 'error', { runId, error: errMsg, status: trace?.status || 'error' });
      } finally {
        activeRuns.delete(runId);
        if (issuedToken && runTokens) runTokens.revokeByRunId(runId);
        if (!res.writableEnded) res.end();
      }
      return true;
    }

    // 5) Stop an in-flight run
    const stopMatch = pathname.match(/^\/api\/loop-agent\/runs\/([^/]+)\/stop$/);
    if (stopMatch) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return true;
      }
      let runId;
      try { runId = decodeURIComponent(stopMatch[1]); }
      catch { sendJson(res, 400, { error: 'Invalid run id.' }); return true; }
      const active = activeRuns.get(runId);
      if (active) active.ac.abort();
      runTokens?.revokeByRunId(runId);
      sendJson(res, 200, { ok: true, stopped: Boolean(active) });
      return true;
    }

    // 6) Flag or unflag a run trace for prompt observation
    const flagMatch = pathname.match(/^\/api\/loop-agent\/runs\/([^/]+)\/flag$/);
    if (flagMatch) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return true;
      }
      let runId;
      try { runId = decodeURIComponent(flagMatch[1]); }
      catch { sendJson(res, 400, { error: 'Invalid run id.' }); return true; }
      const body = await readBody(req, res);
      if (!body) return true;
      const secretValues = await collectSecretValues(vault);
      const redactor = createRedactor(secretValues);
      const redact = (text) => (redactor.hasSecrets ? redactor.redact(String(text ?? '')) : String(text ?? ''));
      const trace = loopAgentStore.flagRun(runId, {
        flagged: body.flagged !== false,
        note: typeof body.note === 'string' ? body.note : '',
        redact,
      });
      if (!trace) { sendJson(res, 404, { error: 'Run trace not found.' }); return true; }
      sendJson(res, 200, { ok: true, trace });
      return true;
    }

    // 7) List / inspect traces
    if (pathname === '/api/loop-agent/traces') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
        return true;
      }
      const flaggedOnly = url.searchParams.get('flagged') === '1' || url.searchParams.get('flagged') === 'true';
      const threadId = url.searchParams.get('threadId') || '';
      const limit = Number(url.searchParams.get('limit')) || 40;
      sendJson(res, 200, {
        ok: true,
        traces: loopAgentStore.listTraces({ flaggedOnly, threadId, limit }),
      });
      return true;
    }

    const traceMatch = pathname.match(/^\/api\/loop-agent\/traces\/([^/]+)$/);
    if (traceMatch) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
        return true;
      }
      let runId;
      try { runId = decodeURIComponent(traceMatch[1]); }
      catch { sendJson(res, 400, { error: 'Invalid run id.' }); return true; }
      const trace = loopAgentStore.getTrace(runId);
      if (!trace) { sendJson(res, 404, { error: 'Run trace not found.' }); return true; }
      sendJson(res, 200, { ok: true, trace });
      return true;
    }

    sendJson(res, 404, { error: 'Not found.' });
    return true;
  }

  return { handle, buildCapabilities };
}
