# ai-workflows

A catalog of AI-first agentic workflows for software work, authored as plain markdown.

TLDR: I believe strongly that humans should be in the driving seat of the decision making and are responsible for the code that AI generates. I am not claiming that these workflows are the right way, but they are the current best way of working for production code for me.

Warning: Subagents consume more tokens than regular work. Workflows are not for "efficiency and speed", they're here for "validation, correctness and less hallucinations".

## Why this exists

Too many teams use AI as a faster way to type. Prompt, accept the suggestion, ship. That works for small things.
Some pass their agency and delegate their cognitive reasoning and decision making to LLMs. This will come back to get you.
Real work needs more: a clear spec, scope you can hold in your head, someone to review the code, and a way to learn from past mistakes. The plan is to address as many of these without needing to repeat ourselves every time you need to implement a change.

From the 2025 [State of AI-assisted Software Development](https://dora.dev/research/2025/dora-report/) report: "AI's primary role is as an amplifier, magnifying an organization's existing strengths and weaknesses."

Every workflow here is a plain markdown contract. It spells out the roles, the gates, the retry limits, the stop conditions, and the failure modes that come with a specific kind of work. They perform best when you run agents in a trusted environment in which they have all permissions.

The workflows make no assumptions about your harness, skills or project, so adapt the role names, gates, and verification steps if you need to. They might need some work from you and your team, make them your own.

## How do I add this to my project?

Copy the workflows you want into your project, keep in mind that workflows have references to files inside the `subagents` folder. Each workflow is just markdown, ready to read. You don't install anything, and there is no runtime.

## I have the files in my project, what now?

Start a new thread and prompt your agent to use the workflow. I use this [subagent-orchestrator](https://github.com/dmonteroh/curated-agent-skills/tree/main/skills/subagent-orchestrator) skill to manage how subagents are handled by the main agent, and then let them do their work.

Here's a quick example for using Task Refinement:
```
Hello :) You are going to be an orchestrator for a workflow, in order for you to perform your best, I need you to read only the absolutely necessary files, the subagents will explore as they need.
Along with the task, please give the subagents the paths to the files used in case they need to get the full contents.
If the workflow asks for subagent files, they are located in: {your path}/workflows/subagents

Please run this workflow: @task-refinement-workflow.md using /subagent-orchestrator

This is the task: {path to existing .md file where you have written part of the task OR paste the task here}
```

## Examples

Worked, end-to-end runs of these workflows, each dispatching real subagents and reproducing their output, live in [examples/](examples/README.md). There is one for task refinement into development (building a small utility), one for a research investigation (cursor vs offset pagination), and one for a spike (regex versus a real parser). Each marks which parts are real captures and which are illustrative, and some include the runnable code they produced so you can try them yourself.

## Token economy and speed

The usage of subagents makes this work more token heavy than working a task end-to-end in a single chat while manually driving the agent. Every subagent started will load your AGENTS/CLAUDE files, and if you have an extensive setup, your subagents will first have to go through that. Now that you know, you can think of options.

The speed issue: when your work isn't meant to be parallel and the subagents need to run sequentially, the verifications and double checks definitely makes the process longer than before.
I have found success in specifying the LLM, model and effort that is used for each step.

For example: The task-refinement-workflow requires, in my opinion, higher effort models like Opus 4.8 or GPT-5.5 (High) in order to make the plan as high-quality and specific as possible. What this means is that the plan gets to be implemented by lower effort or smaller models without loss of quality. This is of course something that you need to experience yourself.
Something else to consider: the "orchestrator" (the agent that you interact with directly) doesn't need a particularly big model to work correctly either. I have run automatic workflows (Ralph Loop) using Haiku and GPT mini with very little issues, if the supporting context is good enough.

## Works well with

- [jlonardi/dot-agent](https://github.com/jlonardi/dot-agent): the `.agent/` directory convention for persistent AI agent context across sessions and tools.
- [dmonteroh/curated-agent-skills](https://github.com/dmonteroh/curated-agent-skills): a curated collection of `SKILL.md`-based agent skills.
- [reaktor/devcontainer-examples](https://github.com/reaktor/devcontainer-examples): a collection of simple devcontainers to get you started, plus a few ideas on how to customize them to your needs. Excellent way of creating environments locally for agents to run free.
