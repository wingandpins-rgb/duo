# Changelog

## Unreleased

### Security
- `duo-safe` (the entry point Codex may run without asking) could still reach things it promised to refuse: `continue` resumed pair runs (a writer with the run's access, plus the check command), `export -o` wrote run text to any path (such as a shell profile), and `rm` deleted runs. All three are refused now.
- `review --commit` and `--base` passed their value to git unchecked, so `--commit=--output=FILE` made git overwrite a file. Values that start with `-` are refused.
- A pair writer could replace its worktree's `.git` link (or point it at a folder it controls) and so give git its own config, which runs `core.fsmonitor`, filters and hooks outside the writer's sandbox the next time duo looked at the diff. duo now checks the link before running git there, and its own git calls in workspaces run no fsmonitor and no hooks. Duo's own "Keep branch" commit therefore skips your repository's commit hooks.
- The permission bridge of *Ask before acting* chats was handed the full API token, in a file other local users could often read. It now gets a secret of its own that can only ask about its chat; the file is owner-only, and duo's data folder is created private.
- Model output could restyle or cover the app (style sheets, inline styles, the app's own CSS classes, popovers, forms), move the window with SVG or image-map links, make a Copy button copy hidden text, and hide characters in the command an approval card shows. The sanitizer refuses all of these, and approval cards show bidi and zero-width characters.
- The Electron shell compared origins with a string prefix, which `http://127.0.0.1:PORT@other.host/` passed; every window now compares exact origins and stays on the app.
- The engine accepted the token in the query string of any request and an `Origin` of any loopback port. Only the event stream and run exports take it in the URL now, and only this engine's own port counts as its origin. `npm run dev` no longer uses the fixed token `dev`.
- Citation checks read any file a model named, outside the project too and of any size; they now stay in the project folder and skip files over 8 MB.
- The Codex `cfg:` denylist missed keys that redirect requests and the sign-in token (`chatgpt_base_url`, `openai_base_url`), add tools (`tools`, `features`, `apps`, `connectors`), or run a program (`js_repl_node_path`); those and all `experimental_*` keys are refused.
- The `/duo` skill for Claude Code pre-approved every `duo` command, including `duo pair --check "<any command>"`; it now pre-approves only the discussion and read-only commands, and writing briefs in `/tmp`.
- `duo setup` and `--uninstall` could delete an unrelated `~/Applications/Duo.app` or replace another tool's `duo` link; they now touch only what setup made.

### Fixed
- A check command that left processes behind (a test runner's workers, a server) could keep a pair run waiting forever, and cancelling a run did not stop it. The whole process tree is stopped on timeout, cancel and exit.
- A continued pair run whose seats could not start left the worktree with neither run, so it could not be applied or discarded.
- Discarding an in-place run did not delete added files with unusual names or renamed files, and the confirmation said only the writer's changes are reverted (any change made since the run started is).
- `duo rm` deleted a pair run that still had a worktree (orphaning it), and accepted any folder with a `run.json`, which it then deleted.
- Deleting a chat while it worked brought it back, could leave its CLI running, and kept its raw transcript and draft.
- The engine crashed when no file manager was installed ("Show folder"), or when a running run's folder was deleted; started twice when its preferred port was taken; froze for minutes during "Update Claude Code", the live sign-in test and the quota refresh; and could be locked up by one malformed preference.
- A Codex web search for the text `null` blanked the chat view.
- Any error while loading a chat (not only a deleted chat) closed its pane.
- `--min-rounds abc` silently disabled early convergence, and the GUI accepted round counts as strings.
- On macOS, Ctrl+N, Ctrl+B and Ctrl+K in a text field opened a chat, the sidebar or the palette; shortcuts no longer repeat when held.
- Links to `mailto:` in model output did nothing.
- Windows: Claude Code installed with npm was not found. duo picked the extensionless script npm writes for Git Bash, which Windows cannot run, and could not read the `.cmd` wrapper of a package that ships a native `.exe`; the setup check reported Claude as not signed in, and Claude seats and chats could not start.
- Windows: stopping a Claude chat, finishing or cancelling a run, or quitting the app ended only the Claude process; what it had started (a shell, a dev server, a test watcher) kept running. The whole process tree is stopped now.
- Windows: CLIs left running by a crash were never cleaned up, because the check that a leftover process is a coding CLI used `ps`. It works on Windows now, and there it also requires the process's parent to be gone, so a Claude Code you started yourself on a reused pid is never stopped.
- Windows: the `/duo` skill could not run `duo` (`command not found`): Claude Code runs commands in Git Bash, and setup wrote only `duo.cmd` and `duo-safe.cmd`. Setup now also writes the scripts Git Bash runs, as npm does for its own commands, and refuses to replace a `duo` command another package installed.

## 0.2.0

### New
- **Pair mode**: one model writes the code in its own git worktree (or in place, with a snapshot), the other reviews every change, and they cycle until the writer reports done, the reviewer approves with no P0/P1 finding open, and an optional check command passes. Apply, keep the branch, or discard the result; continue with a note. `duo pair`, `duo apply`.
- A redesigned desktop app: home screen with one composer for every mode, animated walkthroughs of each mode, live activity of every seat during runs, command palette, keyboard shortcuts, pinned chats, date-grouped history, confirm dialogs, notifications, Settings with a setup check (and a live sign-in test), light and dark themes.
- Runs can be stopped, deleted and exported as Markdown from the app; continuing a run opens the new run.
- `--no-project` (and "No folder" in the app) for questions that are not about a project: the seats get an empty folder.
- Linux, macOS and Windows support: platform data folders, launchers for each OS from `duo setup`, no shell scripts.

### Fixed (found in real runs)
- Windows short folder names (such as `RUNNER~1`) could send a pair writer outside its worktree when Git expanded the path; both paths are now resolved natively and the selected subfolder must stay inside the repository.
- A turn could record the previous turn's tool calls and errors when it started within a second of the last one.
- A Claude seat whose process died between turns failed every later turn with "Session not ready"; it is now restarted on the same conversation.
- Errors that a retry cannot fix (outdated Claude Code, expired sign-in, unknown model, plan limits) were retried and let the other seats spend quota for minutes; the run now stops at once with a fix hint.
- Codex reconnect notices ("Reconnecting… idle timeout") were recorded as errors.
- Models newer than the rate card (`gpt-6.1-sol`) were priced at zero credits; the card is updated and newer models are priced by family.
- Codex `none` and `minimal` efforts were silently dropped.
- Citations with spaces in the path (or Windows drive letters) were rejected as malformed.
- Debates with several seats produced hundreds of claims nobody could take a stance on; claims are capped per seat.
- Continuing a continued debate replayed only the last run's rounds.
- The chair's synthesis was recorded as round 0.
- Codex seats loaded the user's installed skills and read Duo's own skill file.
- Codex prompts are passed on stdin (long debate prompts hit argument length limits).
- The app's saved state was lost on every launch (the window's origin changed with the port); preferences are now kept by the engine and the port is stable.
- Empty chats piled up in the sidebar; a chat is now saved on its first message.
- The app hung for 45 seconds on logout and was killed; it now shuts down promptly and stops its sessions.
- Runs interrupted by a crash stayed "running" forever.

## 0.1.0

- First version: debate, review, council, ask and continue protocols; seat specs with per-seat model, effort and Codex options; full traces; the desktop app with chats, side by side and runs.
