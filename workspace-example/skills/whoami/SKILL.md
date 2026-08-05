---
name: whoami
description: Reports who is asking and from which Slack channel, using the context variables the harness sets. TRIGGER when someone asks "who am I", "where are we", or wants to check that skills work.
---

# Whoami

The smallest possible skill, here to prove the pipeline: the harness listed it
in the system prompt, you read this file, next you run the script with the bash
tool and report what it says. If that round trip works, the workspace is wired
up correctly.

## Usage

```sh
sh skills/whoami/whoami.sh
```

It prints one JSON object: the asking person's Slack name and id, the channel's
name and id — the `DAD_*` variables the harness sets for every command — and
the directory the command ran in. Answer in prose with what it says; don't
paste the raw JSON.

A value of `unknown` means the harness could not resolve that name, usually a
missing `*:read` scope on the Slack app — see the main README's setup section.
