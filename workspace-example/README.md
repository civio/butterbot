# Example workspace

The smallest workspace pi-dad can do something with: one skill, no credentials
needed. `.env.example` points `DAD_WORKSPACE` here, so a fresh clone can answer
a question and run a skill before you build a workspace of your own.

A workspace is just a directory the agent works in. pi-dad looks for two
things in it. `skills/<name>/SKILL.md`: frontmatter (`name:`, `description:`,
optional `channels:` to limit where it is offered) followed by the
instructions the model reads when a request matches, with its scripts next to
the SKILL.md, run with the bash tool. And `memory/`: Markdown the agent writes
to remember things between conversations — a global `MEMORY.md` plus one file
per channel or DM — which appears on its own the first time it is asked to
remember something. Both are re-read on every message, so edits need no
restart.

Everything else is up to you — and everything here is readable and writable by
the model, which is why credentials and harness logs must live outside it (see
the Secrets and Configuration sections of the main README). With the Docker
sandbox, this directory is what gets mounted at `/workspace`.

To start your own, copy this directory and replace the `whoami` skill with
something real.
