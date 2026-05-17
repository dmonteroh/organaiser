# ai-workflows

A catalog of AI-first agentic workflows for software work, authored as plain markdown.

## Why this exists

Most teams use AI as a faster way to type. Prompt, accept the suggestion, ship. That works for small things, but real work needs more: a clear spec, scope you can hold in your head, someone to review the code, and a way to learn from past mistakes.

From the 2025 [State of AI-assisted Software Development](https://dora.dev/research/2025/dora-report/) report: "AI's primary role is as an amplifier, magnifying an organization's existing strengths and weaknesses."

Every workflow here is a plain markdown contract. It spells out the roles, the gates, the retry limits, the stop conditions, and the failure modes that come with a specific kind of work.

## How to use

Copy the workflows you want into your project. Each one is just markdown, ready to read. You don't install anything, and there is no runtime. The workflows make no assumptions about your harness or layout, so adapt the role names, gates, and verification steps as needed.

## Works well with

- [jlonardi/dot-agent](https://github.com/jlonardi/dot-agent): the `.agent/` directory convention for persistent AI agent context across sessions and tools.
- [dmonteroh/curated-agent-skills](https://github.com/dmonteroh/curated-agent-skills): a curated collection of `SKILL.md`-based agent skills.
- [reaktor/devcontainer-examples](https://github.com/reaktor/devcontainer-examples): a collection of simple devcontainers to get you started, plus a few ideas on how to customize them to your needs.
