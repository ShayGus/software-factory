# Third-party notices

This distribution composes independently licensed open-source components.
Original copyright notices and license texts remain authoritative.

| Component | Public source and pinned release | License |
| --- | --- | --- |
| FirstMate | [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate), imported root history with owner fork fixes | [MIT](LICENSE) |
| tasks-axi | [kunchenguid/tasks-axi](https://github.com/kunchenguid/tasks-axi), imported Beads-capable history | [MIT](tools/tasks-axi/LICENSE) |
| Scotty | [brendan-appstart/bead-me-up-scotty](https://github.com/brendan-appstart/bead-me-up-scotty/tree/cf6dda198db15a77399d1d9e77292618a7d08fa1), commit `cf6dda198db15a77399d1d9e77292618a7d08fa1` | [MIT](licenses/scotty.LICENSE) |
| Beads | [gastownhall/beads](https://github.com/gastownhall/beads/tree/v1.1.0), bd 1.1.0 build `8e4e59d39f34` | [MIT](licenses/beads.LICENSE) |
| Dolt | [dolthub/dolt](https://github.com/dolthub/dolt/tree/v2.7.2), 2.7.2 image pinned by digest | [Apache-2.0](licenses/dolt.LICENSE) |

Scotty source, Beads binaries and Dolt images are fetched during setup from their public sources.
Dependency pins and archive checksums are maintained in `services/dependencies.json`.
Node, Debian packages and npm transitive dependencies retain their respective licenses in the installed distributions.
Claude Code and Codex are separately installed authenticated clients; model services and account charges are not part of this source distribution.
