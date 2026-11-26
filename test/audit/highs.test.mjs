// Pass/fail checks for the 20 high-severity findings of the 2026-11-20 audit.
//
//   npm run test:audit          (about a minute; not part of `npm test`)
//
// Each finding has a probe under probes/ that plays the attack against this checkout, in a throw-away home and
// data folder on random ports. A probe prints `PROBE-RESULT <label>: <value>` lines; the checks below read them.
//
// Every finding ends up in one of three states:
//   reproduces    at least one symptom of the finding is still there
//   fixed         the scenario ran as the audit ran it and none of the symptoms are there
//   inconclusive  the probe crashed, timed out, or the scenario did not play out as expected. Never counted as fixed.
//
// known-open.json lists the findings that are still open. The suite is green when reality matches that list:
//   listed     + reproduces  -> pass   (known, not fixed yet)
//   listed     + fixed       -> FAIL   delete the finding from known-open.json to record the fix
//   not listed + fixed       -> pass   (closed, and still closed)
//   not listed + reproduces  -> FAIL   a closed finding is back
//   inconclusive             -> FAIL   always
//
// To close a finding: fix the code, run `npm run test:audit`, delete its line from known-open.json when told to.
// If a fix makes Loop refuse an earlier step of a probe's scenario, the finding turns inconclusive: update the probe
// (or the check here) so that it asserts the refusal. Do not add a finding to known-open.json to get a green run.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_OPEN = JSON.parse(readFileSync(path.join(HERE, 'known-open.json'), 'utf8')).open;
const TMP = mkdtempSync(path.join(os.tmpdir(), 'loop-audit-')); // every probe's fake home and data live here
const PROBE_TIMEOUT_MS = 180_000;
const PARALLEL_PROBES = 4;

const P = {
  deviceClaim: 'probes/G1/p1-device-claim.mjs',
  claimState: 'probes/G1/p2-claim-state.mjs',
  masking: 'probes/G2/p1-masking.mjs',
  oauthMask: 'probes/G2/p2-oauth-mask.mjs',
  policy: 'probes/G2/p3-policy-bypass.mjs',
  placeholderScan: 'probes/G2/p9-redos.mjs',
  upstreamSignIn: 'probes/G4a/p4-discovery-trust.mjs',
  retry: 'probes/G4b/p2-gateway-retry-lasterror.mjs',
  tenantInflate: 'probes/G5/p10-tenant-inflate.mjs',
  urlToken: 'probes/G5/p14-import-url-token.mjs',
  selfImport: 'probes/G6/p4b-host-selfimport-keyed.mjs',
  importUrlKey: 'probes/G6/p7-import.mjs',
  plantedConfig: 'probes/G6/p12-plugin-vault-exfil.mjs',
  importedRefs: 'probes/G6/p13-mcpjson-vault-bypass.mjs',
  approvalBanner: 'probes/G7/p4-approval-banner.mjs',
  consentScreen: 'probes/G7/p6-consent-sse.mjs',
  repoint: 'probes/lead/v-g3b03-repoint.mjs',
};
// These two measure time, so they run alone after everything else has finished.
const TIMED_PROBES = [P.placeholderScan, P.tenantInflate];

class Inconclusive extends Error {}
const asArray = (value) => (Array.isArray(value) ? value : []);
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
// Loop said no with a clear error, as opposed to a route that is gone or a crash.
const clearRefusal = (step) => step.status >= 400 && step.status < 500 && step.status !== 404 && step.status !== 405 && Boolean(step.error);

// A finding's check returns { premises, symptoms }.
//   premises: [what, holds]             the scenario was set up as the audit ran it; if one fails -> inconclusive
//   symptoms: [what, present, note?]    what the finding looks like; any present -> reproduces, none -> fixed
const FINDINGS = [
  {
    id: 'G1-01',
    title: 'A remote user who reaches Loop through a forwarder is treated as the owner of the Mac',
    probes: [P.deviceClaim],
    check(r) {
      r.failIfPrinted('A.error', 'B.error', 'C.error');
      const viaForwarder = r.obj('A.status via TCP forwarder (attacker, own Clerk account)');
      const viaProxy = r.obj('B.status via Host-rewriting proxy with X-Real-IP');
      const byHeader = r.obj('C.device decision by forwarding header');
      const stillTheMac = Object.entries(byHeader)
        .filter(([name, decision]) => name !== 'none (plain loopback)' && String(decision).startsWith('DEVICE'))
        .map(([name]) => name);
      return {
        premises: [
          ['the attacker signed in through the forwarder with an account of their own', viaForwarder.status === 200 && viaForwarder.signedIn === true],
          ['the request through the Host-rewriting proxy was answered', viaProxy.status === 200],
          ['the header-by-header check ran', Object.keys(byHeader).length > 1],
        ],
        symptoms: [
          ['through a plain TCP forwarder, a remote account is treated as the Mac itself', viaForwarder.workspace === 'local' || viaForwarder.canImportLocal === true || viaForwarder.localAvailable === true],
          ["that account lists the owner's Vault keys", asArray(r.json('A.attacker sees root vault keys')).includes('OWNER_GITHUB_TOKEN')],
          ["that account reads the owner's agent key", r.obj('A.attacker reads root agent key (no password)').equalsOwnersKey === true],
          ['through a proxy that rewrites Host and adds only X-Real-IP, a remote account lands in the Mac workspace', viaProxy.workspace === 'local' || viaProxy.canImportLocal === true],
          ['requests that carry proxy headers still count as coming from the Mac', stillTheMac.length > 0, stillTheMac.join(', ')],
        ],
      };
    },
  },
  {
    id: 'G1-02',
    title: 'The first account to sign in on the Mac gets the original workspace without the Loop password',
    probes: [P.claimState],
    check(r) {
      r.failIfPrinted('a.error');
      const first = r.obj('a.first device sign-in by a NON-owner account');
      const restore = r.obj('a.claim-local even for the claimer itself');
      return {
        premises: [['a second account signed in on the Mac', first.workspace === 'local' || first.workspace === 'personal']],
        symptoms: [
          ['an account that is not the owner got the original Mac workspace on first sign-in, with no password asked', first.workspace === 'local'],
          ["that account reads the original owner's agent key", r.json('a.housemate reads the original owner agent key') === true],
          ['the password-protected restore answers "already restored" (409) before it checks any password', restore.status === 409],
        ],
      };
    },
  },
  {
    id: 'G2-01',
    title: "Upstream error text that contains a connection's secret is shown to agents",
    probes: [P.masking],
    check(r) {
      const http = r.obj('add bad');
      const local = r.obj('add crashy');
      return {
        premises: [
          ['a cloud connection whose upstream rejects the key was added and recorded an error', http.status === 201 && Boolean(http.lastError)],
          ['a local connection that crashes on start was added and recorded an error', local.status === 201 && Boolean(local.lastError)],
        ],
        symptoms: [
          ["loop__search shows the cloud connection's secret inside its last error", r.json('loop__search connections leaks CONN_KEY') === true],
          ["loop__search shows the local connection's secret inside its last error", r.json('loop__search connections leaks STDIO_KEY') === true],
          ["loop__inspect shows the cloud connection's secret", r.obj('loop__inspect bad').leaksConnKey === true],
          ["loop__inspect shows the local connection's secret", r.obj('loop__inspect crashy').leaksStdioKey === true],
        ],
      };
    },
  },
  {
    id: 'G2-02',
    title: "Resource and prompt errors return the upstream's raw message, secret included, and log it",
    probes: [P.masking],
    check(r) {
      const resource = r.obj('resources/read error');
      const prompt = r.obj('prompts/get error');
      return {
        premises: [
          ['reading a resource returned an error message', Boolean(resource.msg)],
          ['getting a prompt returned an error message', Boolean(prompt.msg)],
        ],
        symptoms: [
          ["a resource error shows the connection's secret to the agent", resource.leaked === true],
          ["a prompt error shows the connection's secret to the agent", prompt.leaked === true],
          ["activity.jsonl holds the connection's secret in plain text", r.json('activity.jsonl contains CONN_KEY plaintext') === true],
        ],
      };
    },
  },
  {
    id: 'G2-03',
    title: 'Sign-in tokens that Loop adds to a connection are not masked in results',
    probes: [P.oauthMask],
    check(r) {
      const tool = r.obj('whoami via loop__run');
      const resource = r.obj('resources/read result');
      return {
        premises: [['the upstream received a Bearer token from Loop and echoed its header', /auth header was: Bearer /.test(String(tool.text))]],
        symptoms: [
          ['a tool result shows the access token to an agent', tool.leaked === true],
          ['a resource shows the access token to an agent', resource.leaked === true],
        ],
      };
    },
  },
  {
    id: 'G2-04',
    title: 'Escaped or encoded copies of a secret pass through masking',
    probes: [P.masking],
    check(r) {
      const forms = [
        ['echo PEM_KEY', 'a JSON-escaped multi-line key', 'echo:'],
        ['echo QUOTE_PW', 'a JSON-escaped password with a quote and a backslash', 'echo:'],
        ['py_json UNI_PW', 'a \\u-escaped password', '{'],
        ['php_json SLASH_KEY', 'a key with escaped slashes', '{'],
        ['url_echo SLASH_KEY', 'a URL-encoded key', 'GET '],
      ];
      return {
        premises: forms.map(([label, , prefix]) => [`the upstream answered the "${label}" call`, String(r.obj(label).text).startsWith(prefix)]),
        symptoms: forms.map(([label, what]) => [`an agent recovers the exact secret from ${what}`, r.obj(label).recoveredEqualsSecret === true]),
      };
    },
  },
  {
    id: 'G6-03',
    title: 'A key inside an imported connection address stays in plain text and is shown to agents',
    probes: [P.importUrlKey],
    check(r) {
      r.failIfPrinted('server.error');
      return {
        premises: [['a connection with a key in its address was imported', r.text('urlkey.import').startsWith('200')]],
        symptoms: [
          ['the key is written to config.json in plain text', r.json('urlkey.plaintextInConfigJson') === true],
          ['an agent without "Can manage connections" reads it through loop__search', r.json('urlkey.restrictedAgent.loop__search.leaks') === true],
          ['an agent without "Can manage connections" reads it through loop__inspect', r.json('urlkey.restrictedAgent.loop__inspect.leaks') === true],
        ],
      };
    },
  },
  {
    id: 'G5-02',
    title: 'Tokens in the query or path of a connection address are not moved to the Vault',
    probes: [P.urlToken],
    check(r) {
      const seen = r.obj('agent (no secrets shared) loop__search connections');
      return {
        premises: [
          ['three connections were imported: one with a header token, one with a path token, one with a query token', r.obj('import').s === 200],
          ['the header token was moved to the Vault', asArray(r.json('vault keys after import')).includes('hdr_Authorization')],
        ],
        symptoms: [
          ['an agent with no shared secrets sees the query-string token', seen.queryTokenVisible === true],
          ['an agent with no shared secrets sees the path token', seen.pathTokenVisible === true],
          ['an agent with no shared secrets sees the header token', seen.headerSecretVisible === true],
        ],
      };
    },
  },
  {
    id: 'G6-01',
    title: "An imported config can point at any Vault secret, including other agents' Loop keys",
    probes: [P.importedRefs, P.plantedConfig],
    check(pasted, planted) {
      pasted.failIfPrinted('ERROR');
      planted.failIfPrinted('ERROR');
      return {
        premises: [
          ['the importing agent had no secrets shared with it', asArray(pasted.json('mgr.secrets')).length === 0],
          ['loop__save refuses the same reference', /not been shared/.test(pasted.text('loop__save.response')) && pasted.json('loop__save.upstreamGot') === null],
          ['the import ran', pasted.has('import.response')],
          ["the import screen listed the config planted in an agent's folder", Boolean(planted.obj('wizard.shows').status)],
        ],
        symptoms: [
          ['a config imported by an agent sent an owner-only secret to the server it named', pasted.text('import.upstreamGot.X-K') === 'sk_live_OWNER_ONLY_0123456789'],
          ["a config imported by an agent sent another agent's Loop key to that server", pasted.json('import.upstreamGot.X-Agent(other agent key)') === true],
          ["a config planted in an agent's folder sent the owner's token to the server it named", planted.text('upstream.received.X-Gh') === 'ghp_REAL_OWNER_TOKEN_0123456789'],
          ["a config planted in an agent's folder sent an agent's Loop key to that server", planted.json('agentKeyMatches') === true],
        ],
      };
    },
  },
  {
    id: 'G3b-03',
    title: 'Pointing a connection at a new address sends its existing, unshared secret there',
    probes: [P.repoint],
    check(r) {
      const owner = r.obj('owner connection');
      return {
        premises: [
          ["the owner's connection works and sends its secret to the original address", owner.status === 201 && owner.legitGotSecret === true],
          ['the agent had no secrets shared with it', asArray(r.json('agent secrets')).length === 0],
          ['a new connection that names the unshared secret is refused', /not been shared/.test(r.text('control: NEW connection with unshared ref'))],
        ],
        symptoms: [["after an agent changed only the address, the owner's secret arrived at the new address", r.json('OWNER secret reached attacker') === true]],
      };
    },
  },
  {
    id: 'G2-08',
    title: 'Adding an unused, auto-approved secret to a call skips a connection\'s "always ask" rule',
    probes: [P.policy],
    check(r) {
      return {
        premises: [
          ['the owner set the connection to always ask', Object.values(r.obj('owner policy')).includes('always_ask')],
          ['a plain call to the tool is held for approval', r.text('a. baseline run') === 'approval_required'],
        ],
        symptoms: [
          ['through loop__run, the same call with an unused auto-approved secret ran without approval', r.text('b. run + unused {{vault:AUTO_S}} arg') === 'EXECUTED'],
          ['through a direct tool call, the same call with an unused auto-approved secret ran without approval', r.text('b2. direct tools/call + unused arg') === 'EXECUTED'],
        ],
      };
    },
  },
  {
    id: 'G2-05',
    title: 'An agent can switch a connection\'s approval rule from "always ask" to automatic',
    probes: [P.policy],
    check(r) {
      const before = Object.values(r.obj('owner policy'));
      const after = Object.values(r.obj('c. policies after'));
      return {
        premises: [
          ['the owner set the connection to always ask', before.includes('always_ask')],
          ['a plain call to the tool is held for approval', r.text('a. baseline run') === 'approval_required'],
        ],
        symptoms: [
          ["an agent's loop__save changed the owner's rule for the connection", !after.includes('always_ask'), `now ${JSON.stringify(r.obj('c. policies after'))}`],
          ['after that, an agent without "Can manage connections" ran the tool with no approval', r.text('c. plain agent run after flip') === 'EXECUTED'],
        ],
      };
    },
  },
  {
    id: 'G2-06',
    title: 'An agent can relabel or overwrite a Vault secret that was never shared with it',
    probes: [P.policy],
    check(r) {
      const pay = r.obj('d. PAY in vault after');
      const answer = r.value('d. metadata save on unshared PAY');
      const shared = r.obj('e. SH after agent value save');
      return {
        premises: [["the owner's payment secret still exists after the attempt", pay.type !== undefined]],
        symptoms: [
          ['an agent changed the type or approval rule of a payment secret that was never shared with it', pay.type !== 'payment' || pay.approval !== 'always_ask', `now type ${pay.type}, approval ${pay.approval}`],
          ["the answer to that save included the secret's description or its last characters", Boolean(answer) && typeof answer === 'object' && (answer.saved === true || 'masked' in answer || 'description' in answer)],
          ['an agent can tell which secret names exist', r.value('d. oracle existing key') === true],
          ["an agent's value save on a shared secret reset the owner's approval rule or note", shared.saveOk === true && (shared.approval !== 'always_ask' || shared.description !== 'Owner note'), `now approval ${shared.approval}, note ${JSON.stringify(shared.description)}`],
        ],
      };
    },
  },
  {
    id: 'G7-02',
    title: 'The approval banner cuts the request off, hiding the recipient and the amount',
    probes: [P.approvalBanner],
    check(r) {
      r.failIfPrinted('probe error', 'banner render error');
      return {
        premises: [
          ['the payment call was held for approval', r.text('approval item keys') !== 'NONE'],
          ['Loop gave the dashboard the recipient, the amount and the secret name', asArray(r.json('full detail has them')).every((present) => present === true)],
          ['the banner was drawn by the dashboard code in public/app.js', r.text('BANNER TEXT').length > 0],
        ],
        symptoms: [
          ['the banner the owner approves from does not show the recipient', r.json('banner shows recipient?') === false],
          ['the banner the owner approves from does not show the amount', r.json('banner shows amount?') === false],
        ],
      };
    },
  },
  {
    id: 'G4b-02',
    title: 'A failed tool call is sent again, so one approved call can run twice',
    probes: [P.retry],
    check(r) {
      r.failIfPrinted('fatal');
      const cases = [
        ['retry.pay', 'a payment the upstream answered with a server error after charging'],
        ['retry.charge_rpc', 'a charge the upstream declined'],
        ['retry.drop', 'a call whose connection dropped after it was sent'],
        ['approval.oneApprovalTwoExecutions', 'a call the owner approved once'],
      ];
      return {
        premises: [
          ['the upstream connection was added', r.obj('add.up').status === 201],
          ...cases.map(([label, what]) => [`${what} reached the upstream`, r.obj(label).upstreamExecutions >= 1]),
        ],
        symptoms: cases.map(([label, what]) => [`${what} ran more than once upstream`, r.obj(label).upstreamExecutions > 1, `${r.obj(label).upstreamExecutions} times`]),
      };
    },
  },
  {
    id: 'G6-02',
    title: 'The agent-facing sync tools do not recognise Loop itself and import it as a connection',
    probes: [P.selfImport],
    check(r) {
      r.failIfPrinted('ERROR');
      const cursorAfter = r.obj('cursor.after');
      return {
        premises: [["the dashboard's own scan recognises Loop's entry in Cursor's config", JSON.stringify(r.json('rest.statuses')) === '["cursor:loop-hub:self"]']],
        symptoms: [
          ['the scan an agent runs lists Loop itself as a new connection', asArray(r.json('mcp.discover.statuses')).some((status) => status.includes(':loop-hub:') && !status.endsWith(':self'))],
          ['Loop imported itself as a connection', asArray(r.json('loop.connections')).length > 0],
          ["the agent's Loop key was copied into the Vault as an ordinary secret", asArray(r.json('vault.keys')).includes('loop-hub_Authorization')],
          ['an agent without "Can manage connections" used the host tools through that connection', r.has('bot.viaSelf.isError') && r.value('bot.viaSelf.isError') === false],
          ["cleanup removed Loop's own entry from Cursor's config", !Object.hasOwn(cursorAfter.mcpServers ?? {}, 'loop-hub')],
        ],
      };
    },
  },
  {
    id: 'G7-01',
    title: 'The agent sign-in screen trusts the name an app gives itself, and approving takes over the existing agent of that name',
    probes: [P.consentScreen],
    check(r) {
      r.failIfPrinted('consent probe error', 'consent screen render error');
      const existing = r.obj('victim pre-existing agent');
      const screen = r.obj('consent screen (live dashboard code)');
      const original = r.obj('victim original Claude Code key still works?');
      return {
        premises: [
          ['an unauthenticated app registered itself as "Claude Code" with a callback on another site', r.obj('DCR (unauthenticated) with name "Claude Code" + https://evil.example/cb').status === 201],
          ['the victim was shown a request they could approve', r.obj('consent API').canApprove === true],
          ['the sign-in screen was drawn by the dashboard code in public/app.js', screen.rendered === true],
          ['the remote app exchanged the approval for a Loop key', r.obj('attacker token exchange (remote)').gotToken === true],
        ],
        symptoms: [
          ['the sign-in screen shows the name the app gave itself with nothing saying it is unverified', screen.saysNameIsUnverified !== true],
          ['the sign-in screen does not show the full callback address', screen.showsFullCallback !== true],
          ['approving attached the remote app to the victim\'s existing "Claude Code" agent and the secrets shared with it', asArray(r.json('victim agents after approval')).some((agent) => agent.id === existing.id && agent.oauthClientId === 'bound')],
          ["the victim's real Claude Code key stopped working", original.ok !== true, `status ${original.status}`],
        ],
      };
    },
  },
  {
    id: 'G4a-01',
    title: 'Signing in to an upstream follows whatever addresses it publishes, including local ones and Loop itself',
    probes: [P.upstreamSignIn],
    check(r) {
      r.failIfPrinted('A ERROR', 'B ERROR');
      const selfMint = r.obj('A.self-mint');
      const internal = r.obj('B.token-endpoint-ssrf');
      return {
        premises: [
          ["the chain through Loop's own sign-in server ran to the end, or Loop refused a step with a clear error", selfMint.stoppedAt ? clearRefusal(selfMint) : selfMint.callbackStatus !== undefined],
          ['the internal-address case ran to the end, or Loop refused a step with a clear error', internal.stoppedAt ? clearRefusal(internal) : Array.isArray(internal.internalHits)],
        ],
        symptoms: [
          ["an upstream pointed Loop at Loop's own sign-in server and received a Loop agent key", selfMint.attackerMcpReceivedLoopKey === true],
          ['that key works on Loop', selfMint.leakedKeyWorksOnLoopMcp === 200],
          ['Loop sent the sign-in code to an internal-only address the upstream chose', asArray(internal.internalHits).length > 0, asArray(internal.internalHits).map((hit) => `${hit.method} ${hit.url}`).join(', ')],
        ],
      };
    },
  },
  {
    id: 'G2-07',
    title: 'A long run of unclosed placeholders freezes Loop for everyone',
    probes: [P.placeholderScan],
    check(r) {
      const FIXED_AT_MOST_MS = 50;
      const SLOW_FROM_MS = 200;
      const largest = asArray(r.json('resolveString scaling')).at(-1) ?? {};
      const ms = largest.vaultResolveMs;
      if (Number.isFinite(ms) && ms > FIXED_AT_MOST_MS && ms < SLOW_FROM_MS) {
        throw new Inconclusive(`resolving the ${largest.kb} KB value took ${ms} ms, between "fixed" (${FIXED_AT_MOST_MS} ms or less) and "still slow" (${SLOW_FROM_MS} ms or more); run it again on a quiet machine`);
      }
      return {
        premises: [['the largest value (20,000 unclosed placeholders) was measured', largest.n === 20000 && Number.isFinite(ms)]],
        symptoms: [['resolving a value made of 20,000 unclosed placeholders blocks Loop', ms >= SLOW_FROM_MS, `${ms} ms for ${largest.kb} KB; the bounded pattern in lib/secret-refs.mjs took ${largest.strictRegexMs} ms on the same value`]],
      };
    },
  },
  {
    id: 'G5-01',
    title: 'One hosted account can inflate its settings file and slow Loop down for every other account',
    probes: [P.tenantInflate],
    check(r) {
      const BIG_FROM_MB = 5;
      const FINE_BELOW_MS = 25;
      const SLOW_FROM_MS = 50;
      const baseline = r.obj('victim baseline tools/list');
      const grown = r.obj('attacker created agents');
      const samples = asArray(r.obj('victim tools/list while attacker loops 8 GETs').victimMs);
      const megabytes = Number(grown.configMB);
      const underLoad = median(samples);
      if (megabytes < BIG_FROM_MB && underLoad >= FINE_BELOW_MS && underLoad < SLOW_FROM_MS) {
        throw new Inconclusive(`the other account's requests took a median of ${underLoad} ms, between "fine" (under ${FINE_BELOW_MS} ms) and "slowed down" (${SLOW_FROM_MS} ms or more); run it again on a quiet machine`);
      }
      return {
        premises: [
          ["the other account's request worked before the attack", baseline.s === 200],
          ['the settings file was measured', Number.isFinite(megabytes)],
          ["the other account's requests were timed during the attack", samples.length === 5],
        ],
        symptoms: [
          ['one account grew its own config.json without limit', megabytes >= BIG_FROM_MB, `${megabytes} MB from ${grown.made} agents, each granted about 900 KB of made-up secret names`],
          ["another account's requests slowed down while that account kept 8 requests in flight", underLoad >= SLOW_FROM_MS && underLoad >= 5 * Math.max(baseline.ms, 1), `${baseline.ms} ms before, median ${underLoad} ms during`],
        ],
      };
    },
  },
];

// ------------------------------------------------------------------------------------------------------------------
// Running the probes
// ------------------------------------------------------------------------------------------------------------------
function runProbe(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, LOOP_AUDIT_TMP: TMP };
    delete env.NODE_TEST_CONTEXT; // set by `node --test`; a probe is an ordinary script
    const child = spawn(process.execPath, [path.join(HERE, file)], { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, PROBE_TIMEOUT_MS);
    const finish = (code, signal) => { clearTimeout(timer); resolve({ file, output, code, signal, timedOut, ms: Date.now() - started }); };
    child.on('error', (error) => { output += `\n${error.stack || error}`; finish(null, null); });
    child.on('close', finish);
  });
}

// Each probe runs once, however many findings read it. All of them start now; the tests below wait for theirs.
const probeRuns = new Map(Object.values(P).map((file) => [file, Promise.withResolvers()]));
(async () => {
  const quick = Object.values(P).filter((file) => !TIMED_PROBES.includes(file));
  await Promise.all(Array.from({ length: PARALLEL_PROBES }, async () => {
    while (quick.length) { const file = quick.shift(); probeRuns.get(file).resolve(await runProbe(file)); }
  }));
  for (const file of TIMED_PROBES) probeRuns.get(file).resolve(await runProbe(file));
})();

const CRASH_LINE = /^(?:PROBE-RESULT )?(?:UNHANDLED_REJECTION|UNCAUGHT_EXCEPTION|UNHANDLED|UNCAUGHT|FATAL|ERROR)\b/;

/** Reads one probe run's PROBE-RESULT lines. Anything missing or unreadable is Inconclusive, never "fixed". */
function reader(run) {
  if (run.timedOut) throw new Inconclusive(`${run.file} did not finish within ${PROBE_TIMEOUT_MS / 1000} seconds`);
  if (run.code !== 0) throw new Inconclusive(`${run.file} stopped with ${run.signal ? `signal ${run.signal}` : `exit code ${run.code}`}`);
  const lines = run.output.split('\n');
  const crash = lines.find((line) => CRASH_LINE.test(line));
  if (crash) throw new Inconclusive(`${run.file} reported a crash: ${crash.slice(0, 300)}`);
  const raw = (label) => {
    const prefix = `PROBE-RESULT ${label}: `;
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    return line === undefined ? undefined : line.slice(prefix.length);
  };
  const parse = (text) => (text === 'undefined' ? undefined : JSON.parse(text));
  return {
    has: (label) => raw(label) !== undefined,
    /** The value exactly as printed. */
    text(label) {
      const value = raw(label);
      if (value === undefined) throw new Inconclusive(`${run.file} did not print "${label}"`);
      return value;
    },
    /** The value as JSON. */
    json(label) {
      const value = this.text(label);
      try { return parse(value); } catch { throw new Inconclusive(`${run.file} printed "${label}" in a form this check cannot read: ${value.slice(0, 200)}`); }
    },
    /** The value as JSON when it is JSON, else as printed (probes print plain strings for refusals). */
    value(label) {
      const value = this.text(label);
      try { return parse(value); } catch { return value; }
    },
    /** The value as a JSON object; {} when the probe printed anything else. */
    obj(label) {
      const value = this.value(label);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },
    /** For the labels a probe prints only when one of its scenarios broke. */
    failIfPrinted(...labels) {
      for (const label of labels) {
        const value = raw(label);
        if (value !== undefined) throw new Inconclusive(`${run.file} reported "${label}": ${value.slice(0, 300)}`);
      }
    },
  };
}

async function judge(finding) {
  const runs = [];
  for (const file of finding.probes) runs.push(await probeRuns.get(file).promise);
  const tail = runs.map((run) => `--- ${run.file} (last lines) ---\n${run.output.trimEnd().split('\n').slice(-25).map((line) => line.slice(0, 400)).join('\n')}`).join('\n');
  try {
    const { premises = [], symptoms } = finding.check(...runs.map(reader));
    const notHeld = premises.filter(([, holds]) => !holds).map(([what]) => what);
    if (notHeld.length) return { state: 'inconclusive', points: notHeld.map((what) => `expected, but not so: ${what}`), tail };
    const present = symptoms.filter(([, isPresent]) => isPresent).map(([what, , note]) => (note ? `${what} (${note})` : what));
    if (present.length) return { state: 'reproduces', points: present, tail };
    return { state: 'fixed', points: symptoms.map(([what]) => what), tail };
  } catch (error) {
    const why = error instanceof Inconclusive ? error.message : `the check could not read the probe output (${error?.message || error})`;
    return { state: 'inconclusive', points: [why], tail };
  }
}

const bullets = (points) => points.map((point) => `  - ${point}`).join('\n');
const howToRun = (finding) => finding.probes.map((file) => `  node test/audit/${file}`).join('\n');
const outcomes = new Map();

for (const finding of FINDINGS) {
  test(`${finding.id}  ${finding.title}`, async (t) => {
    const listedOpen = Object.hasOwn(KNOWN_OPEN, finding.id);
    const { state, points, tail } = await judge(finding);
    outcomes.set(finding.id, state === 'inconclusive' ? 'INCONCLUSIVE' : state === 'fixed' ? (listedOpen ? 'FIXED: update known-open.json' : 'closed') : (listedOpen ? 'open' : 'BACK AGAIN'));

    if (state === 'inconclusive') {
      assert.fail(`${finding.id} could not be judged, and that is never counted as fixed.\n${bullets(points)}\n`
        + 'If your change is the reason (Loop now refuses an earlier step), update the probe or its check in test/audit/highs.test.mjs so it asserts that refusal.\n'
        + `Otherwise the probe is broken. Run it by itself:\n${howToRun(finding)}\n${tail}`);
    }
    if (state === 'reproduces' && !listedOpen) {
      assert.fail(`${finding.id} is back. It is not listed in test/audit/known-open.json, so it was closed, and now:\n${bullets(points)}\nRun the probe by itself:\n${howToRun(finding)}`);
    }
    if (state === 'fixed' && listedOpen) {
      assert.fail(`${finding.id} no longer reproduces. If your change fixed it, delete "${finding.id}" from test/audit/known-open.json; `
        + `from then on this test fails if it comes back.\nNone of these happen any more:\n${bullets(points)}`);
    }
    t.diagnostic(state === 'reproduces' ? `${finding.id} still open, as listed:\n${bullets(points)}` : `${finding.id} closed, and still closed`);
  });
}

test('known-open.json lists only findings this suite checks', () => {
  const unknown = Object.keys(KNOWN_OPEN).filter((id) => !FINDINGS.some((finding) => finding.id === id));
  assert.deepEqual(unknown, [], `known-open.json lists ${unknown.join(', ')}, which this suite has no check for`);
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  const count = (label) => [...outcomes.values()].filter((outcome) => outcome === label).length;
  console.log(`\nAudit findings, high severity: ${count('open')} still open, ${count('closed')} closed, ${outcomes.size - count('open') - count('closed')} needing attention`);
  for (const finding of FINDINGS) console.log(`  ${(outcomes.get(finding.id) ?? 'not run').padEnd(30)} ${finding.id.padEnd(7)} ${finding.title}`);
});
