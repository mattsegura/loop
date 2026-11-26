# Feedback evals

Each file in `cases/` is one request to a real agent (Claude Code) with a throwaway Loop. `npm run eval:feedback` runs the reviewed ones.

```sh
npm run eval:feedback -- --model sonnet,haiku --runs 3
npm run eval:feedback -- --case tool-user-asks --json
```

The agent has the Loop tools and nothing else. It uses your Claude Code sign-in and costs about one cent for each run. An agent does not answer the same way every time: run a case several times before you believe a change.

| Field | Meaning |
| --- | --- |
| `id`, `about` | Name and one line about the case. |
| `reviewed` | `false` until a person read it. A case that came from feedback was written by a model about untrusted text. |
| `prompt` | The request, as a user would write it. Use invented names. |
| `turns` | Instead of `prompt` and `expect`: a conversation, as a list of `prompt` and `expect`. Each `expect` is checked after the answer to its prompt. |
| `shared` | `true`: a server where other people have a Loop, so agents ask the user first. |
| `state` | The choice of the owner before it starts: `on` or `off`. Without it, the owner has not decided. |
| `connections` | Services in that Loop: `name`, and `tools` with `name`, `description`, `inputSchema` and the `result` or `error` they give. |
| `fault` | Optional: `tool` and `error`. Every call of that Loop tool fails with that text. With `internal: true` it also gets the hint that Loop adds to its own internal errors. |
| `expect.feedback` | `none` (default), `one` or `any`. |
| `expect.source`, `expect.type` | What each report has to be. |
| `expect.noText` | Texts that no call of the feedback tool may hold. |
| `expect.calls`, `expect.ran` | Loop tools that were called, and `Service/tool` that ran. |
| `expect.answerHas` | Texts in the answer to the user. |
| `expect.state` | What the owner's choice is now: `ask`, `on` or `off`. |
| `expect.asks` | `true` or `false`: the answer asks the user if agents may send feedback. |
