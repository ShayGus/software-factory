# Software Factory

Software Factory is a complete personal software-development system for one person managing several projects through AI agents.
Describe the outcome in Claude chat; FirstMate carries it through understanding, design, planning, checked worker instructions, implementation and product review against the original request.
The repository includes FirstMate, the factory toolkit and screens, the Beads-capable tasks-axi tool, and reproducible service installation.
No other FirstMate session is needed to install or operate it.

## Prerequisites

Use a Linux amd64 or arm64 machine with Node.js 22.13+, npm, Git, Bash, Python 3, jq, curl, tar, tmux, GitHub CLI, and Docker Engine configured to start at boot.
Install and authenticate Claude Code and Codex before setup; model usage is billed through your own accounts.
Install FirstMate's `treehouse`, `no-mistakes`, `gh-axi`, `chrome-devtools-axi` and `quota-axi` tools as described in [FirstMate setup](docs/firstmate.md#quick-start).
Setup checks required local tools and reports missing dependencies; it never changes machine-wide Docker or account settings.
The persistent services use Linux Unix sockets and bind their browser ports to loopback.
For access from your own devices, optionally install Tailscale, sign in to your tailnet, enable HTTPS certificates, and grant your setup user permission to run Tailscale Serve.
Tailscale and Docker must start at boot for unattended tailnet access.
Keep the installed folder at its original absolute path.

## Clone, setup and start

```sh
git clone https://github.com/ShayGus/software-factory.git my-factory
node my-factory/services/setup.mjs
cd my-factory
claude
```

Setup builds the bundled sources, fetches pinned public dependencies, starts dedicated Dolt, view-only Scotty and factory screens, and prints their addresses.
When Tailscale is running with HTTPS available, setup also configures persistent, tailnet-only HTTPS addresses and prints them beside the local addresses.
Those addresses use your device’s Tailscale DNS name and the same port numbers; tailnet access follows your Tailscale access policy.
Setup preserves other Serve ports and refuses conflicting routes or public Funnel on its ports.
Without Tailscale or HTTPS, local setup still completes and reports why tailnet access was skipped; use the one-step update after enabling Tailscale to add it.
It finishes with a real non-interactive Claude acceptance session using the normal startup hooks, factory skill and backlog.
The check spends model tokens and setup fails if it cannot prove the installed system works.
Re-running setup on a completed folder verifies it without replacing its data or settings.
Run `node services/setup.mjs --help` for executable, Docker and port overrides, and `--check` to repeat live acceptance at both local and configured tailnet addresses.
All three containers restart with Docker after reboot; no chat session has to keep them alive.
Installation records and full acceptance output remain private inside the folder.

## Use it

In Claude chat, say:

> Add my project from https://github.com/me/my-project. Use local-only delivery and ask me before landing changes.

FirstMate registers and clones the project using its normal project-intake flow.
Then give a concrete request, for example:

> In my-project, add CSV export for the current filtered results. Preserve the displayed column order and include tests.

The factory preserves your original words, grounds its design in the repository, checks the plan and each worker's instructions, and reviews the delivered product against the request.
Workers use Codex with GPT-6.1 Sol; product review uses Claude.
The factory screens edit product records through canonical operations.
Scotty shows the execution backlog and dependency graph; writes through Scotty are refused.
You approve landing according to the project's registered delivery posture.
See [the workflow](factory/skills/software-factory/SKILL.md) and [product design](factory/Software_Factory_Design.md).

## Update from chat

Say **"update the factory"** to the FirstMate running in this folder.
The bundled update skill runs the guarded FirstMate updater, rebuilds bundled tools and services, preserves backlog, projects, settings and service data, and repeats acceptance.
An unsafe checkout or unfinished worker prevents the update before source or containers change.
The command is `node services/update.mjs`; failures retain evidence and never reset, stash or discard work.
`/updatefirstmate` remains the source-update mechanism; the factory update includes rebuilding and acceptance as well.

## Develop the factory itself

In this folder's FirstMate chat, say:

> Register this running clone itself as software-factory with local-only delivery, yolo off. Use its absolute path as the project target, keeping FirstMate here. I will approve each landing.

Then request the change:

> In software-factory, [describe the desired product change]. Use the normal factory flow and show me the product review before landing.

FirstMate uses an isolated worker checkout, the same checked planning/build/product-review flow and your explicit landing approval.
After approval, ask it to land the ready branch into the running home and run `node services/update.mjs --local`.
That command rebuilds the approved local commit and repeats acceptance without fetching over local work.
Local development grants no publication authority; publishing to your fork requires your explicit task consent under the [self-repository rules](.agents/skills/firstmate-self-repo/SKILL.md).
No upstream contribution or maintainer role is enabled by installation.

## Repository and privacy

[ARCHITECTURE.md](ARCHITECTURE.md) describes the component and data boundaries; [VISION.md](VISION.md) explains the intended outcomes.
The original [FirstMate guide](docs/firstmate.md), [vision](docs/firstmate-vision.md) and [architecture](docs/architecture.md) remain available.
`AGENTS.md` and Claude's startup hooks retain FirstMate's supervisor contract.
Private `data/`, `state/`, `config/`, `projects/`, `beads/`, `.tools/`, credentials and service data are ignored by Git.
Cloning copies source and pinned installation instructions, never another home's backlog or credentials.
Contributor documentation follows the [audience inventory](docs/documentation-audiences.md).

## Licenses

FirstMate and tasks-axi retain their MIT licenses.
Scotty and Beads are MIT; Dolt is Apache-2.0.
See [LICENSE](LICENSE), [tasks-axi's license](tools/tasks-axi/LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution, pinned sources and license copies.
