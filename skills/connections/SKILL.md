---
name: "connections"
description: "Find a tool in a connected account, add a missing connection, or restore one that stopped working."
---

# Connections

Start with the job and account the user named. Search `loop__search({ type: "tools", query: "<job>" })` for the action, or search `type: "connections"` to see which accounts are available. Use the returned tool name and input schema. If the schema is missing, inspect that tool before running it.

If nothing matches, check whether an existing connection offers the action under another name. For a requested new connection, verify the provider and endpoint from its official documentation. Use the connection save flow and present the sign-in link Loop returns. Don't guess a URL, promise access before sign-in, or ask the user to paste credentials into chat. Ask before introducing an unrequested service or cost.

If a connection stops working, inspect its status first. Distinguish missing project access, expired sign-in, and a provider outage. Use the offered reconnect path rather than deleting the connection or changing grants. After sign-in, verify with a small read in the intended account before resuming the original job. Do not repeat a write if its result is uncertain.
