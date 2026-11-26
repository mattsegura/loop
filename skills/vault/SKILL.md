---
name: "vault"
description: "Use when the user sends a reusable credential directly, needs a secure form for a new login or API key, or wants to use a saved credential with an authorized connection."
---

# Vault

## The user already sent the secret

If the user directly supplies a reusable API key, token, or password, save it to their Loop Vault using the create-only capture action. They do not need to say “save it,” confirm another time in chat, or retype it in a form. Respect an explicit request not to save. Never harvest credentials from logs, attachments, examples, or tool output. Do not capture one-time codes.

Use a service label only if the user supplied enough context. Otherwise omit the label and let Loop create a neutral one. Never use the secret itself as a key, label, URL, or search query. Send it only in the protected value field of the Vault tool. Do not put it in Memory, a task, an artifact, or an approval description.

For example, call `loop__save({ type: "api_key", action: "capture", id: publicServiceLabel, data: { value: suppliedCredential } })`. Use `type: "login"` for a password. Omit `id` when unknown. Do not substitute an ordinary update or upsert.

Only report success after a saved receipt. Reply with the entry name, not the secret. Capture does not authorize replacing an entry, sharing it, connecting an account, testing the credential, or sending it to any service. If access is denied, say it was not saved; do not try another store or ask the user to resend it.

## No credential has been sent

Call the same capture action without `data.value` for the secure form handoff. Give the user Loop’s returned link, never ask them to paste the value into chat. A link means the form is ready, not that an entry has been saved.

## Use an existing entry

Find permitted metadata with `loop__search({ type: "vault" })`. Pass the returned `{{vault:KEY}}` placeholder only to the intended, authorized connection. Follow the approval result. Saving a credential does not erase it from the chat where it was originally sent.
