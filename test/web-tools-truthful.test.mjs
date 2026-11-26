// The built-in web tools must not give a result that looks like a real answer when it is not one:
// a blocked search is not "no results", and the bytes of a PDF are not the text of a page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { callBuiltinTool, isDuckDuckGoChallenge, resetWebSearchBlock } from '../lib/builtin-web.mjs';
import { classifyUpstreamError } from '../lib/mcp-errors.mjs';
import { safeFetchWeb } from '../lib/web-extract.mjs';

const respond = (body, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const pdfWith = (text) => Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n', 'latin1'),
  deflateSync(Buffer.from(`BT (${text}) Tj ET`, 'latin1')),
  Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
]);

const web = (tool, args, fetchImpl, extra = {}) => callBuiltinTool('loop_web', tool, args, { fetchImpl, ...extra });

// What an agent gets: the same classification that the server makes of a thrown error.
const failure = async (promise) => {
  const err = await promise.then(() => assert.fail('The call must fail.'), (e) => e);
  return classifyUpstreamError({ ...err, name: err.name, cause: err.cause, message: err.message }, { isReadOnly: true });
};

const CHALLENGE = '<html><body><div class="anomaly-modal__mask"><form id="challenge-form">Unfortunately, bots use DuckDuckGo too.</form></div></body></html>';
const RESULTS = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example.com%2Fpage">Alpha <b>page</b></a><a class="result__snippet" href="#">Snippet text</a></div>';

test('a search that the provider blocks is an error, not an empty result', async () => {
  resetWebSearchBlock();
  let now = 1_000_000;
  let fetches = 0;
  const blockedFetch = async () => { fetches += 1; return respond(CHALLENGE, { status: 202 }); };
  const goodFetch = async () => { fetches += 1; return respond(RESULTS); };
  const clock = { now: () => now };

  const blocked = await failure(web('web_search', { query: 'loop mcp hub' }, blockedFetch, clock));
  assert.equal(blocked.code, 'SEARCH_BLOCKED');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.retryable, false, 'a new search at once makes the block longer');
  assert.equal(blocked.recovery.action, 'use_another_route');
  assert.match(blocked.message, /not a search with no results/);
  assert.equal(fetches, 1);

  // While the block is fresh, Loop does not send a search at all.
  now += 30_000;
  assert.equal((await failure(web('web_search', { query: 'another' }, goodFetch, clock))).code, 'SEARCH_BLOCKED');
  assert.equal(fetches, 1);

  // After the wait, search works again.
  now += 31_000;
  const later = await web('web_search', { query: 'another' }, goodFetch, clock);
  assert.deepEqual(later.results, [{ title: 'Alpha page', url: 'https://a.example.com/page', snippet: 'Snippet text' }]);
  assert.equal(later.note, undefined);
  assert.equal(fetches, 2);
  resetWebSearchBlock();
});

test('the human check is found by its status or by its page, and a page with results is never a check', () => {
  assert.equal(isDuckDuckGoChallenge({ status: 202, text: '' }), true);
  assert.equal(isDuckDuckGoChallenge({ status: 200, text: CHALLENGE }), true);
  assert.equal(isDuckDuckGoChallenge({ status: 200, text: RESULTS }), false);
  assert.equal(isDuckDuckGoChallenge({ status: 202, text: RESULTS }), false);
  assert.equal(isDuckDuckGoChallenge({ status: 200, text: '<div class="no-results">No results found</div>' }), false);
});

test('a search with no results says which kind of empty it is', async () => {
  resetWebSearchBlock();
  const none = await web('web_search', { query: 'zzzz' }, async () => respond('<div class="no-results">No results found for zzzz</div>'));
  assert.deepEqual(none.results, []);
  assert.match(none.note, /found no results/);
  const odd = await web('web_search', { query: 'zzzz' }, async () => respond('<html><body>a new page layout</body></html>'));
  assert.deepEqual(odd.results, []);
  assert.match(odd.note, /not proof that there are no results/);
});

test('web_fetch gives the text of a PDF, by its content type or by its first bytes', async () => {
  const byType = await web(
    'web_fetch',
    { url: 'https://docs.example.com/files/Annual%20report.pdf' },
    async () => respond(pdfWith('Annual report 2026: revenue grew 12 percent in the year.'), { contentType: 'application/pdf' }),
  );
  assert.equal(byType.markdown, 'Annual report 2026: revenue grew 12 percent in the year.');
  assert.equal(byType.title, 'Annual report.pdf');
  assert.equal(byType.contentType, 'application/pdf');
  assert.doesNotMatch(JSON.stringify(byType), /%PDF-|FlateDecode/);

  const byBytes = await web(
    'web_fetch',
    { url: 'https://docs.example.com/download' },
    async () => respond(pdfWith('The file has this readable text in it.'), { contentType: 'application/octet-stream' }),
  );
  assert.equal(byBytes.markdown, 'The file has this readable text in it.');
});

test('web_fetch refuses content that is not text, and never returns its bytes', async () => {
  const scan = await failure(web(
    'web_fetch',
    { url: 'https://docs.example.com/scan.pdf' },
    async () => respond(Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nstream\n\x00\x01\x02\x03\nendstream\n', 'latin1'), { contentType: 'application/pdf' }),
  ));
  assert.equal(scan.code, 'UNSUPPORTED_CONTENT');
  assert.equal(scan.status, 415);
  assert.equal(scan.retryable, false);
  assert.match(scan.message, /PDF with no text/);

  const image = await failure(web(
    'web_fetch',
    { url: 'https://img.example.com/a.png' },
    async () => respond(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), { contentType: 'image/png' }),
  ));
  assert.equal(image.code, 'UNSUPPORTED_CONTENT');
  assert.match(image.message, /image\/png/);

  const unknown = await failure(web(
    'web_fetch',
    { url: 'https://img.example.com/blob' },
    async () => respond(Buffer.from([1, 2, 0, 0, 5, 6, 7]), { contentType: '' }),
  ));
  assert.equal(unknown.code, 'UNSUPPORTED_CONTENT');

  // JSON from an API is text, also with a vendor content type.
  const api = await web('web_fetch', { url: 'https://api.example.com/x' }, async () => respond('{"a":1}', { contentType: 'application/vnd.api+json' }));
  assert.equal(api.markdown, '{"a":1}');
});

test('a web failure gets the class of its cause', async () => {
  const missing = await failure(web('web_fetch', { url: 'https://example.com/missing' }, async () => respond('nope', { status: 404 })));
  assert.deepEqual([missing.code, missing.status, missing.retryable], ['UPSTREAM_ERROR', 404, false]);

  const down = await failure(web('web_fetch', { url: 'https://example.com/down' }, async () => respond('nope', { status: 503 })));
  assert.deepEqual([down.code, down.retryable], ['UPSTREAM_UNAVAILABLE', true]);

  for (const [tool, args] of [
    ['web_fetch', { url: 'notaurl' }],
    ['web_fetch', { url: 'http://127.0.0.1:8799/api/vault' }],
    ['web_fetch', { url: 'https://example.com/', maxChars: 5 }],
    ['web_search', { query: ' ' }],
    ['web_search', { query: 'x', maxResults: 99 }],
    ['web_feed', { url: 'https://example.com/feed.xml', maxItems: 0 }],
  ]) {
    const bad = await failure(web(tool, args, async () => respond('x')));
    assert.deepEqual([bad.code, bad.status, bad.retryable], ['INVALID_INPUT', 400, false], `${tool} ${JSON.stringify(args)}`);
  }
});

test('the time limit of Loop is a timeout of the website, and a cancel by the caller stays a cancel', async () => {
  const slow = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
  const timedOut = await failure(safeFetchWeb('https://slow.example.com/', { fetchImpl: slow, timeoutMs: 3000 }));
  assert.equal(timedOut.code, 'UPSTREAM_TIMEOUT');
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.retryable, true);
  assert.match(timedOut.message, /slow\.example\.com did not answer in 3 seconds/);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await failure(safeFetchWeb('https://slow.example.com/', { fetchImpl: slow, signal: controller.signal }));
  assert.equal(cancelled.code, 'CALL_CANCELLED');
  assert.equal(cancelled.retryable, false);
});
