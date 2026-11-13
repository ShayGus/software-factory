# Contributing

Contribute to the complete Software Factory in this repository.
Read [ARCHITECTURE.md](ARCHITECTURE.md) for ownership boundaries and [VISION.md](VISION.md) for product intent.
Preserve the licenses and provenance of the bundled projects.
Never commit home-private data, settings, credentials or service databases.

## Development

Create a branch in an isolated checkout and make bounded changes with behavior-level tests.
Read [FirstMate coding guidelines](.agents/skills/firstmate-coding-guidelines/SKILL.md) before changing shared FirstMate material.
Do not extend project `AGENTS.md` or `CLAUDE.md` with new knowledge; those always-loaded files retain their existing role contracts.
Use the component's own build and tests: `npm ci && npm test` in `factory/`, and `npm ci && npm test` in `tools/tasks-axi/`.
Root shell changes also require `bash bin/fm-lint.sh` and appropriate tests under `tests/`.
Installation changes require a fresh committed clone, real setup acceptance and an idempotent rerun; retain proof outside tracked source.
Use [documentation audiences](docs/documentation-audiences.md) to place and classify maintained prose, and run `bash bin/fm-doc-audience-check.sh`.

Publication and merging require the owner's authorization and selected delivery contract.
Never infer permission from repository access or authentication.
Contributing changes back to FirstMate itself follows its preserved [upstream contribution guide](docs/firstmate-contributing.md).
The [upstream maintenance procedure](ARCHITECTURE.md#upstream-maintenance) keeps FirstMate and tasks-axi releases mergeable.
