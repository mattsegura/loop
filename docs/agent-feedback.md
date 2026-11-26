# Agent feedback

Agents use Loop all day, so they meet its faults first. With `loop__send_feedback` they report them, and the maintainers turn the reports into fixes and tests:

1. An agent sends a report.
2. Triage sorts the reports into issues and drops what is not useful.
3. A person accepts an issue, and it goes to the people or agents who fix it.
4. The task behind the report becomes an eval.
5. The issue is closed. If new reports of it come in, it opens again.

The code is `lib/feedback.mjs` (the tool and the store), `lib/feedback-triage.mjs`, `scripts/feedback.mjs` (the commands below) and `scripts/eval-feedback.mjs`.

## What goes in

Where feedback is on, every agent gets the tool, also one that can only read. The text agent (SMS, iMessage) does not. The tool is only for Loop itself: its own `loop__*` tools, answers, instructions, built-in skills, sign-in and approvals. A connected service that fails, or that the user did not connect, is not feedback about Loop.

Agents read about it in three places: the description of the tool, one line in the instructions at the start of a session, and the error text when a Loop tool fails with an internal error. The last one matters most for small models: when another way worked, Haiku reported the fault in 0 of 9 runs without it and in 9 of 9 runs with it.

| Field | Meaning |
| --- | --- |
| `content` | What Loop did, what was expected, what would be better. |
| `type` | `bug` or `improvement`. |
| `source` | `model` if the agent sends it on its own, `user` if the user asked for it. |
| `about`, `task` | Optional: the part of Loop, and what the agent tried to do in one general sentence. |

Loop adds the app and its version, the MCP protocol version, the transport, and the Loop build. Workspace and agent are kept only as keyed one-way tags, so that reports can be counted and deleted by their owner.

The tool asks the agent to remove personal data. Loop does not rely on that:

- Values of the workspace's Vault, also encoded ones, are covered. The answer to the agent stays the same, so nothing can be learned from it.
- Text that looks like a credential is refused, and the agent is told to write it again.
- Email addresses, phone and account numbers, IP addresses, long ids, home folders and the path of every link are replaced.
- Characters that a person cannot see are removed. If they can carry hidden text, no model reads the report until a person releases it.
- An agent can send 5 reports in an hour and 20 in a day on its own, and a workspace 100 in a day. The same report again only counts up. Reports go after 180 days.

Feedback goes in through MCP and never comes out through MCP: no tool, resource or search of Loop returns a report. The owner sees the reports of their own agents in **Settings → Security** and deletes them there.

## Who decides

A Loop on your own computer keeps the reports there and sends them nowhere, so feedback is on until you turn it off. A server where other people have a Loop (`LOOP_PUBLIC_ORIGIN` or `LOOP_HUB_ALLOWED_HOSTS`) keeps them for its operator. There each person is asked before the first report:

1. An agent meets a fault of Loop and calls the tool, as always. Loop does not keep the report and answers with the question for the user.
2. The agent finishes the task and asks the user at the end of its answer. This works in every app.
3. It saves what the user says with `loop__save({ type: "feedback", data: { enabled: true } })` or `false`. After a yes it sends the report again.

No answer is no yes, and no agent asks again for 7 days. A report that the user asks for (`source: "user"`) goes out one time and decides nothing else. An agent that may not change this Loop does not have the tool before the owner decides, and cannot bring the answer.

The owner changes the choice at any time: through an agent, with the same call, or in **Settings → Security** (Ask, On or Off). The activity list names the agent that changed it. A backup brings a no to another server, but never a yes.

`LOOP_AGENT_FEEDBACK=off` takes feedback away from the whole server. No setting of the operator answers for other people.

## Work with it

```sh
npm run feedback                                  # issues by score
npm run feedback -- triage                        # sort new reports, then draft the issues
npm run feedback -- show iss_1a2b3c4d             # one issue: draft, places in the source, evidence
npm run feedback -- accept iss_1a2b3c4d           # or: reject
npm run feedback -- push iss_1a2b3c4d --to github # shows what it would send; add --yes to send it
npm run feedback -- eval iss_1a2b3c4d             # writes its test case
npm run feedback -- close iss_1a2b3c4d            # it is fixed
```

`push --to tasks` makes a Loop task in this data folder instead, and `--assign <agent>` hands it to an agent. `--data <folder>` works on another data folder. `npm run feedback -- help` lists everything.

Reports of the production server: `sh deploy/feedback.sh` copies them into the data folder of this computer, with the deletions that their owners made. It changes nothing on the server. Triage then runs here, not on the server.

When an account is closed, run `npm run feedback -- forget <workspace id>` on the server as the user `loop`, then `deploy/feedback.sh`.

To triage every day, run these two from cron or launchd. Nothing is accepted or pushed without a person:

```sh
sh deploy/feedback.sh && npm run --silent feedback -- triage
```

## Who reads what

A report is untrusted. Any agent, or any page that an agent read, can shape it, and a report that tells its reader to do something is the attack to expect. So no agent that can act reads one.

| Reader | Reads | Can |
| --- | --- | --- |
| Sorter (`claude -p`) | The cleaned text of the reports | Nothing: it has no tools, network, MCP servers, settings or keys. It answers with fixed choices and one sentence in its own words. |
| Reviewer (`claude -p`) | Those sentences, after a check, and a copy of the source | Read files in that copy. It has no shell, network or MCP servers. |
| Maintainer | Everything, with `--raw` in a terminal | Accept, reject, release, push |
| Agent that fixes it | The accepted issue, marked as a report to check | What it can always do |

- The sorter holds what gives orders to its reader or holds personal data. `list held` shows those reports, `release` and `drop` decide on them.
- Everything a model writes is checked again: known choices, one plain line, no links, mentions, markup or paths outside the source.
- An app gives its own name and version. Names that Loop does not know are "another app", so they carry no text either.
- The score counts workspaces and apps first. One agent that repeats itself does not get to the top.
- `--raw` needs a terminal, so an agent does not read the text by accident. This is a guard, not a lock: an agent with a shell can open the file, so keep triage instructions clear that agents must never read raw reports directly.

## Evals

`npm run eval:feedback` runs a real agent against a throwaway Loop, for each case in `eval/feedback/cases`. The format is in `eval/feedback/README.md`. The `tool-*` cases test the tool itself: that an agent reports a fault of Loop, stays quiet when all is well or a service fails, sends no personal data, and does not obey a text that tells it to send something. The `consent-*` cases test a public server: that an agent asks once and only after a fault, brings the yes or the no, takes no answer as no yes, and turns feedback on and off when the user says so and never when a text does.

`npm run feedback -- eval <issue>` adds a case for an issue. Its text came from an agent, so it does not run before a person reads it and sets `reviewed` to true.

## On a public server

The reports reach the operator, and triage sends the cleaned text to a model provider. `public/privacy.html` says so. Keep the two in step: what is collected, who processes it, for how long, and how a person stops it. The page promises to announce a material change in the app or by email. To run a server without feedback, set `LOOP_AGENT_FEEDBACK=off` in `/etc/loop/loop.env`.
