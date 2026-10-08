Put files back the way they were at the start of an earlier turn.

Every edit the agent makes is backed up before it happens, and each turn keeps up to five of those checkpoints. This tool rewinds a turn: for every file that turn touched, it restores the exact bytes the file had when the turn began.

- `turn_id` — which turn to rewind. Defaults to the most recent turn that changed files.
- `paths` — restore only these files. Defaults to every file the turn changed. Relative to the current working directory, or absolute.
- `force` — overwrite a file that has changed since the turn ended. Off by default.

Before restoring, the tool compares the file on disk with the copy taken at the end of that turn. If they differ, something outside the turn has touched the file since, and the restore stops with a `conflict` for that path instead of discarding newer work. Pass `force: true` to restore anyway. The turn currently in progress has no end-of-turn copy, so nothing is compared against it.

Each path comes back with one state:

- `restored` — the earlier bytes were written back.
- `unchanged` — the file already matched, so nothing was written.
- `conflict` — the file drifted after the turn ended. Restore with `force` to overwrite.
- `oversize` — the file was larger than 4 MiB when the turn started, so no copy was kept.
- `unavailable` — no backup exists for this path.

Prefer this over re-editing by hand after a bad change: the bytes come back exactly, including whitespace and line endings. It cannot recover a file that was never backed up, and it does not restore deletions of files it has no record of.

Restoring is itself recorded, so a restore can be undone by rewinding the turn it ran in.