// The address of a connection that somebody else lends to this Loop ("Uses mine" in lib/people.mjs).
//
// The record in the borrower's Loop holds only this address. It is not a place on the network: Loop
// hands the call to the lender's Loop inside this server, and the share id alone proves nothing,
// because the server also checks which Loop the call comes from. Nothing may ever open this address.
// Dependency-free on purpose: the connection pool and the server both import it.

export const SHARED_URL_PREFIX = 'https://people.useloop.sh/c/';
const SHARED_URL_RE = /^https:\/\/people\.useloop\.sh\/c\/([a-z0-9]{12})$/;
const SHARED_HOST_RE = /^https?:\/\/people\.useloop\.sh(?:[:/?#]|$)/i;

export function buildSharedUrl(shareId) {
  return `${SHARED_URL_PREFIX}${shareId}`;
}

export function parseSharedUrl(url) {
  return typeof url === 'string' ? (SHARED_URL_RE.exec(url.trim())?.[1] ?? null) : null;
}

// Every address on that host, also a malformed one: none of them may reach the network.
export function isSharedConnection(conn) {
  return typeof conn?.url === 'string' && SHARED_HOST_RE.test(conn.url.trim());
}
