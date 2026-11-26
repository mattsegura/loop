// These hosts run their connector setup inside the product. "muse" is the local Muse Code CLI.
export const HOST_KINDS = ['grok-bot', 'claude-duet', 'meta-muse', 'openmausbot', 'openbot'];

// The selected Loop workspace must be reachable from the host. Never redirect a grant to another Loop.
export function publicMcpEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { return ''; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
  if (!host.includes('.') || /\.(?:localhost|local|internal|test)$/.test(host)) return '';
  if (/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return '';
  if (!/^\/(?:w\/[a-z0-9_-]+\/)?mcp\/?$/i.test(url.pathname)) return '';
  for (const key of url.searchParams.keys()) if (!['project', 'profile'].includes(key)) return '';
  return url.href;
}

export function hostSetup(kind, endpoint, fixed = false) {
  const target = publicMcpEndpoint(endpoint);
  if (!HOST_KINDS.includes(kind) || !target) return null;
  const url = target;
  const steps = {
    'grok-bot': 'In Grok Bot, go to Connect apps → Add a custom connector → Remote HTTPS. Name it Loop and enter the server URL. Every Bot on your Grok account can use this connection.',
    'claude-duet': 'In Claude on the web, open Customize → Connectors → Add custom connector. Name it Loop and enter the server URL. Duet uses connectors from the same Claude account.',
    'meta-muse': 'Ask your personal Muse to create a custom Loop connector. Follow its setup prompts. Only enter credentials in a secure credential field.',
    openmausbot: 'In OpenMausBot, open Plugins → MCP servers → Add server. Name it Loop and enter the server URL.',
    openbot: 'In OpenBot, open Connections → Add custom MCP. Enter the server URL. Your organization’s app policy controls who can add it.',
  };
  const auth = fixed ? {
    'grok-bot': 'Add an HTTP header named Authorization. Paste the header value from Loop.',
    'claude-duet': 'Use Request headers to add Authorization with the value from Loop. For an organization, a fixed credential is shared by everyone using that connector.',
    'meta-muse': 'Use this invite only if Muse offers a private credential field for a Bearer token. Stop if it asks for a key in chat or asks you to sign in as the workspace owner.',
    openmausbot: 'Add a header named Authorization with the value from Loop. Use a personal connection for a personal grant.',
    openbot: 'For a personal deployment, paste the raw key in Key. In a team deployment an admin-entered key is shared. Use this grant there only if it is intended for the whole team.',
  }[kind] : {
    'grok-bot': 'Authorize Loop in your browser, then send your Bot a new message.',
    'claude-duet': 'Select Sign in now and Register automatically. Authorize Loop, then open Duet to try it there.',
    'meta-muse': 'Request a browser sign-in to Loop. If Muse cannot finish that sign-in, leave the connector pending.',
    openmausbot: 'Leave the OAuth client ID blank to register automatically. Save, then sign in to Loop when prompted.',
    openbot: 'Leave Key empty. Continue with your own Loop sign-in from OpenBot.',
  }[kind];
  const prompt = kind === 'grok-bot' || kind === 'meta-muse'
    ? `Add a custom connector named Loop using the remote MCP server at ${url}. ${fixed ? 'Show me a secure credential field for its Bearer token. If that is unavailable, stop setup.' : 'Open the Loop authorization page so I can choose access.'}` : '';
  // The HTTPS form from xAI's deep-link builder opens the app from a browser.
  const open = kind === 'grok-bot' && prompt.length <= 1000 ? `https://cursor.com/grok-bot/link/v1/prompt?text=${encodeURIComponent(prompt)}` : '';
  return { url, steps: steps[kind], auth, prompt, open, rawKey: kind === 'openbot' || kind === 'meta-muse' };
}

export function hostSetupHtml(setup, esc) {
  if (!setup) return '<p>This agent needs a publicly reachable HTTPS Loop workspace. Open that workspace and start setup there.</p>';
  const copy = (field, label) => `<button type="button" class="btn sm" data-host-copy="${field}">${label}</button>`;
  return `<p>${esc(setup.steps)}</p>
    <p class="code"><code>${esc(setup.url)}</code></p>
    ${copy('url', 'Copy server URL')}
    <p>${esc(setup.auth)}</p>
    ${setup.open ? `<a class="btn" href="${esc(setup.open)}" rel="noreferrer">Open prompt in Grok Bot</a><p class="hint">Send it from your primary Bot, or copy the prompt into any Bot.</p>` : ''}
    ${setup.prompt ? copy('prompt', 'Copy setup prompt') : ''}
    <p>After the host adds Loop, ask the agent to read something from the account you shared. A successful read confirms that account is usable.</p>`;
}
