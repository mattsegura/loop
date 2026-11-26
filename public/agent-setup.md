# Connect to Loop

Use the MCP endpoint supplied alongside the link to this guide. Connect from the machine running Loop when the endpoint is a loopback address.

For this session, use your client's session-only MCP connection option if available. Register the endpoint as a Streamable HTTP server named loop. If your client requires a persistent configuration change, ask the user before making it.

Start the MCP connection and follow the server's OAuth discovery flow. Present the sign-in or consent link to the user for approval. On Loop's screen the user chooses what this agent can reach, and each authorization creates its own agent. After authorization, list the server's tools to confirm the connection.

## Using Loop

- **4-Tool Surface:** Loop exposes `loop__search`, `loop__inspect`, `loop__run`, and (when allowed) `loop__save` for every agent.
- **Discovery & Execution:** Call `loop__search` with `type: "all"`, `"tools"`, `"skills"`, `"connections"`, `"memory"`, `"tasks"`, `"vault"`, or `"categories"`. Results are short rows. The best tool matches carry an inline `inputSchema`, and one or two clear skill matches carry their `SKILL.md`, so you can act in 1–2 steps. Use `loop__inspect({ type, id }` or `ids: [...]`) for full details and `loop__run` to execute tools. An id can also be the name the user says, and `queries: [...]` looks up several things in one call.
- **Approvals:** By default Loop runs a tool without a question, also one that can delete or overwrite; it asks before it uses a card or a login from the Vault. The owner can make Loop ask for a kind of tool, a Connection, a tool or a Vault item. `loop__inspect({ type: "tool", id })` shows a tool's `approvalPolicy` before you run it. Deleting a saved item asks too, except a memory, task or Skill that you saved in the last hour and that nobody changed since. `ids: [...]` deletes several items with one approval. When a call returns `status: "approval_required"`, give the user its `approveUrl` and call again with the same arguments, the returned `approvalId`, and `waitForApproval: true`. One call waits at most 50 seconds; repeat it to wait on.
- **Pre-flight validation & Vault safety:** Loop validates required inputs and types before calling upstream and returns missing/invalid fields plus `inputSchema` in one step. Never ask the user for raw secrets in chat — use `{{vault:KEY}}` placeholders and direct the user to any `signInUrl`, `updateKeyUrl`, `approveUrl`, or `viewInLoop` links Loop returns.
