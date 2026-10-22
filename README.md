# gentl

A readability test for codebases. A memoryless agent carries out a realistic task the way a newcomer would (clone the repo, set up the environment from the docs, make a change, verify it), and gentl measures how much the agent had to read. The premise is that if an agent with no memory beyond a small set of notes can do the task, a human newcomer probably can too.

gentl is an evaluation tool, not a coding agent; the code the agent writes is a by-product. There are two outputs: the reading effort (a number, mostly useful as a trend over doc changes) and a friction report from an evaluator (what was missing or wrong in the docs, and where the agent guessed).

Status: early.

## Install

Requires Node >= 20 and Docker (or use `--host`).

```
npm install -g @magland/gentl
```

From source: `git clone https://github.com/magland/gentl && cd gentl && npm install && npm link`.

For the default backend, set `OPENROUTER_API_KEY` in the environment or in a `.env` file in the directory you run from. To use your Claude Code subscription instead, pass `--backend claude-code` (or set `GENTL_BACKEND=claude-code`); see Backends.

## Usage

```
gentl run TASK.md
gentl run -t "Clone https://github.com/owner/foo, install it and run its tests."
gentl run tasks/            # a suite: every *.md in the directory
gentl run https://<hub>/tasks/42 --upload   # a task from a hub; see Hub
```

A task is plain text. It names the repos to clone and, where it matters, the tag or commit; the agent does the cloning itself.

Options:

- `--image IMG`: the Docker image for the sandbox. The default is built on first use from [sandbox/Dockerfile](sandbox/Dockerfile) and tagged by its content (`gentl-sandbox:<hash>`).
- `--host`: run on this machine in a fresh temp directory instead of Docker, for software that can't run in a container (for example a licensed MATLAB).
- `--matlab-on-host`: `--host` set up for the MATLAB installed on this machine; see Host mode.
- `--confirm`: ask before each action. This is the default with `--host`; Docker runs are unattended unless you pass it.
- `--yes`: with `--host`, run actions without asking.
- `--model M`: the agent's model, default `anthropic/claude-haiku-5.5`.
- `--evaluator-model M`: the evaluator's model, same default.
- `--upload`: upload each run that finishes, reaches the turn limit or is aborted to the hub its task came from.
- `--yes`: don't ask before running a hub task (and, with `--host`, before each action).
- `--backend B`: `openrouter` (default) or `claude-code`; see Backends.
- `--local` / `--remote`: serve clones of the task's repo from your checkout (the default inside a git repo), or clone the published repo; see Local copy.
- `--base-url URL`: any OpenAI-compatible endpoint (default `https://openrouter.ai/api/v1`). The key in `OPENROUTER_API_KEY` is sent to it.
- `--max-turns N`: default 250.
- `--repeat N`: run each task N times; see Repeated runs.
- `--keep`: keep the container or temp workspace instead of deleting it.

### Local copy

When the task file (or suite directory, or the current directory for `-t`) is inside a git repo with an `origin` remote, gentl serves clones of that origin from your checkout, including uncommitted changes. So you can edit the docs and rerun without pushing. At startup gentl makes a temporary bare mirror of your checkout; uncommitted changes (tracked and untracked, not ignored) become one extra commit, "Work in progress", under your git identity, on top of your current branch. Your own repo, index and working tree are not touched. The sandbox's git config then redirects the origin URL (in its https, http, `git@host:` and `ssh://` forms, with and without `.git`) to the mirror with `url.<mirror>.insteadOf`, so the agent runs the `git clone` the task names. In Docker the mirror is mounted read-only at `/srv/git`. A suite uses one mirror for all its tasks. gentl prints the local copy at the start, and records it in `summary.json` (`local_copy`); the evaluator is told about it.

`--remote` turns this off; `--local` makes it an error if there is no repo to serve. Hub tasks (later) will always clone the published repo.

Limits:

- Pages the agent reads on GitHub through w3m or curl still show the pushed version, and a task that pins a tag or commit gets that version, not your edits.
- `git remote -v` in the agent's clone shows the mirror's `file://` URL, so an agent that looks can tell.
- git's `insteadOf` matches by prefix, so `https://github.com/owner/foo` also catches `https://github.com/owner/foo-extra`. gentl warns when the task text mentions such a URL.

### Docker (default)

Each run gets a fresh container (`docker run --init`, working directory `/work`, network enabled), removed at the end. The default image is Debian (trixie) with Python 3.13, Node, build tools, git, curl and w3m; pip works as root without a virtual environment. The agent's commands run with `docker exec` under `setsid`, so a timeout or Ctrl-C kills the whole command inside the container. A custom image needs bash and `setsid` (util-linux), and git for most tasks. No environment variables from your machine are passed into the container.

The image and its id are recorded in `summary.json`.

### Host mode

The agent works in `work/` inside a fresh temp directory, with `HOME` set to a sibling `home/` so it does not see your git config, caches or credentials. Only a few environment variables are passed through (`PATH`, locale, proxies); API keys and tokens are not. Each command runs in a fresh bash shell in its own process group, with no input and a 300 s timeout. The workspace is deleted at the end unless `--keep` is given.

The agent can still reach anything on your machine that you can, so by default gentl shows each action and asks `ok? [y/n]` before running it. On `n` you can give a reason, which is passed back to the agent.

Some licensed software keeps its licensing state in your home directory, which the agent's empty HOME does not have. `--share-home PATH` (repeatable) links that part of your real home directory into the agent's HOME, read and write, leaving the rest hidden; `--pass-env NAME` (repeatable) passes one more environment variable through. Both are printed at the start and recorded in `summary.json`. For MATLAB there is a shortcut, `--matlab-on-host`: it implies `--host` and shares `.matlab`, `.MathWorks` and `.MATLABConnector` (those that exist), which MATLAB's licensing needs (tested with R2025b and online licensing; without them MATLAB fails with licensing error 5201). It warns if there is no `matlab` command on your PATH. As with `--host`, add `--yes` to run without confirming each action:

```
gentl run TASK --matlab-on-host --yes
```

Host mode also inherits whatever is installed on your machine (compilers, Python packages, uv), so setup steps can succeed without the docs being followed, and reading effort is not comparable with Docker runs.

### Suites

`gentl run DIR` runs every `*.md` file in the directory, in name order, skipping `README.md` and files starting with `_`. The task name is the file name. Runs go to `runs/<timestamp>-<suite>/<run>/`, and at the end gentl prints a results table (verdict, self-report, turns, read tokens, notes max, questions, cost) and writes it to `results.md` and `results.json` in the suite directory. Aborting a run with Ctrl-C skips the remaining runs.

### Repeated runs

Reading effort varies a lot from run to run, since the agent may take a different route each time, so a single run says little. `--repeat N` runs each task N times, one after another, into `runs/<timestamp>-<task>-xN/` (or the suite directory). Besides the per-run table, it reports per task the success rate (runs the evaluator judged successful) and the median, interquartile range and range of read tokens, the median turns and the median notes max, all over the successful runs only.

Each suite should include a baseline task ("clone, install, run the tests"). Its reading effort is the repo's onboarding cost; read other tasks against it rather than subtracting it.

## How it works

Each turn the model sees only the system prompt, the task, its notes, and its last action with the result (shown once). It returns one JSON object:

```
{"notes_keep": false, "notes": "...", "notes_edit": {"old": "...", "new": "..."}, "notes_append": "...", "action": {...}}
```

The notes are the agent's working memory, meant to mimic how much a person can hold in their head at once, so the agent is asked to keep them small. `notes_keep` and `action` are required. Each turn the agent either updates its notes (`notes_keep: false` with one or more of the operations, applied in order: rewrite, edit, append) or keeps them as they are (`notes_keep: true`). Making the choice explicit matters: without it, models often wrote the action first and skipped the notes, then forgot what they had learned. If a response makes no notes decision anyway, gentl asks again within the same turn, once, with a short reminder (counted as reading and recorded as `notes_reminders`).

A memoryless agent can also go in circles, rereading the same sections because nothing tells it it has read them. Two things work against that. The prompt asks the agent to keep a short log in its notes of what it has read and what it gave, to check it before reading, and to act on a result in the turn it sees it (for code: read the whole region to change at once, then edit) rather than collecting a file piece by piece. And when the agent repeats an action it already took at any earlier turn, the result says so, naming those turns (counted as reading; `repeated_actions` in the summary).

Actions:

- `run {cmd, max_chars?}`: bash in the working directory. stdout and stderr are combined. Output longer than `max_chars` (default 2000, at most 20000) is cut in the middle, keeping the head and tail, and the result's first line says so.
- `read_file {path, start_line?, end_line?}`: exactly the requested lines of a file, numbered, never cut in the middle; a range over 20000 characters stops at a line boundary and says where to go on. The prompt asks the agent to read files this way rather than with `cat` or `sed`, whose output, like any command's, is cut in the middle when long. Without it, an agent reading part of a file would get both ends of the range and not the middle, ask for the middle, lose the rest, and go round in circles.
- `write_file {path, content}` and `edit_file {path, old, new}` (`old` must occur exactly once). When `old` does not match, the error says why if it can: a backslash sequence in the code (`\n` in a string) written in the JSON as a real line break, or else the file's lines closest to it.
- `ask {question}`: no one answers. The question is recorded as a gap in the docs, and the agent is told to decide from the docs and code.
- `finish {success, summary, friction?}`: the summary cites the evidence of success; `friction` is the agent's own account of what was missing or unclear in the docs.

gentl asks for structured output (a JSON schema) so responses parse reliably; if the backend rejects it, gentl falls back to plain text and parses the first JSON object that contains an `action`.

## Backends

- `openrouter` (default): any OpenAI-compatible chat completions endpoint, OpenRouter unless `--base-url` says otherwise, with the key in `OPENROUTER_API_KEY`. Each turn is one request with the system prompt and one user message.
- `claude-code`: your Claude Code login, through a fresh `claude -p` process per call, with no tools, no settings files (so no CLAUDE.md, memory, hooks or plugins), no MCP servers and no saved session. Model ids like `anthropic/claude-haiku-5.5` are mapped to `claude-haiku-5-5`. Claude Code still adds a short preamble and an environment block (cwd, platform, date) to the system prompt, about 740 tokens; `--bare` would remove them but works only with an API key. Effort is Claude Code's default unless `GENTL_CLAUDE_EFFORT` is set. Reported cost is notional. The model call runs on your machine; the sandbox (Docker or host) is unaffected.

The backend is recorded in `summary.json`. Runs with different backends are not directly comparable.

### Stopping a run

Ctrl-C aborts the run wherever it is: a running command is killed and a model call cancelled. The run is recorded with stop reason `aborted`, evaluated (its verdict is always a failure, and the friction report covers what happened up to the abort), and, with `--upload`, reported to the hub. A second Ctrl-C during the evaluation skips it. The sandbox is removed in every case. A command that hangs is also stopped by the 300 s timeout, and the agent is told. SIGTERM and SIGHUP (the process killed, the terminal closed) end the run with stop reason `interrupted`, without an evaluation or upload; the run directory is still written.

## Evaluation

After a run that finishes, reaches the turn limit or is aborted, gentl records the final state of the workspace: for each git repo, `git status`, the commits and `git diff` against its upstream, and untracked files; also any loose files in the working directory. Then an evaluator (one model call) reads the full log, with the parts of each result that the agent did not see marked as such, the questions asked, the agent's finish report and the final state. It writes:

- a verdict: did the agent actually accomplish the task, judged from the evidence rather than the agent's claim;
- a friction report: docs used, what was missing or wrong, where the agent guessed, signs of prior knowledge (commands or APIs it used that never appeared in anything it read), and the questions it asked.

The evaluator reads only the run directory, so a run can be evaluated again later, for example with another model:

```
gentl evaluate runs/<id> --evaluator-model anthropic/claude-sonnet-5.5
```

The evaluator's tokens are not counted as reading effort. Reading effort should be compared only among runs that the evaluator judged successful, with the same agent model.

## Hub

A hub ([gentl-hub](https://github.com/magland/gentl-hub); the public one is https://gentl-hub.jeremy-magland.workers.dev) holds tasks with titles, shows the command to run each, and collects uploaded runs. gentl contacts a hub only when given a hub task URL or asked to upload.

- `gentl run https://<hub>/tasks/<id>` fetches the task, prints its title and text, and asks before running it (`--yes` skips this). Hub tasks always clone the published repo, never a local copy, so uploaded results match public code.
- `--upload` uploads each run that finished, hit the turn limit or was aborted (Ctrl-C) to that hub; `gentl upload runs/<id>` uploads one later, and `gentl upload runs/<batch>` uploads every run in a batch. A run goes only to the hub its task came from.
- The first upload to a hub asks for your name (shown with your runs) and the hub's passcode, and offers to remember them in `~/.config/gentl/hubs.json` (mode 0600). `GENTL_HUB_USER` and `GENTL_HUB_PASSCODE` override it.
- The upload holds `summary.json`, `evaluation.json`, `final-state.md`, and each turn as the agent saw it (notes, action, shown result); full command output stays local.

## Measurement

Tokens are counted with tiktoken `o200k_base` on exactly what the agent sees, so counts do not depend on the model.

- `read_tokens_total` = `notes_tokens_total` + `result_tokens_total`, summed over turns. This is the headline number.
- `notes_tokens_max`: the largest the notes got, i.e. the most the agent had to hold at once.
- `result_tokens_*`: the echoed action plus its result, per turn.
- `overhead_tokens`: system prompt plus task, counted once.

Also recorded: turns, model output tokens, provider-reported tokens and cost, parse errors, invalid, repeated and declined actions, and the questions asked.

## Run directory

Each run is written to `./runs/<YYYYMMDD-HHMMSS>-<task name>/`:

- `events.jsonl`: a `start` event, one `turn` event per turn (full model input and response, parsed response, notes, full and shown result, where the shown result was cut, token counts, provider usage), and an `end` event.
- `summary.json`: totals and settings, with a `format` version (currently 1).
- `transcript.md`: the task, system prompt and each turn as the agent saw it.
- `final-state.md`: the final state of the workspace (see Evaluation).
- `evaluation.json` and `friction.md`: the evaluator's verdict and friction report. The verdict is also copied into `summary.json` under `evaluation`.

## License

Apache-2.0
