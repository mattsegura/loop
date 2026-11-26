# Security policy

Loop holds other people's credentials: Vault secrets, OAuth tokens, agent keys and payment details. Please report anything that could expose them or let one agent, user or workspace reach another's data.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a security problem.

Include what you need for us to reproduce it: the Loop version or commit, local or hosted mode (`LOOP_HOSTED`), the steps or a script, and what an attacker gains.

You can expect an acknowledgement within 3 working days and a first assessment within 10. We will tell you when a fix ships and credit you in the release notes unless you would rather not be named.

## What is in scope

- An agent reading a secret value it was not given (Loop's rule is that agents see secret names and `{{vault:KEY}}` placeholders, never values).
- Skipping, lowering or misrepresenting an approval.
- One hosted user or workspace reaching another's connections, Vault, memory or activity.
- Remote access to the local (device) workspace, or running programs on the server from a hosted personal workspace.
- Server-side request forgery from hosted workspaces to private or internal addresses.
- Flaws in Loop's OAuth 2.1 server, Clerk sign-in handling or upstream OAuth flows.

## What is out of scope

- An agent or person that already has shell access as the same OS user on the machine running a local Loop. Agent keys are not a sandbox against local code execution.
- Vulnerabilities in upstream Connections themselves, unless Loop makes them reachable when they otherwise would not be.
- Missing hardening with no demonstrated impact.

## Supported versions

Security fixes go into the latest release on `main`.
