# gentl

A readability test for codebases. A memoryless agent carries out a realistic task the way a newcomer would (clone the repo, set up the environment from the docs, make a change, verify it), and gentl measures how much the agent had to read. The premise is that if an agent with no memory beyond a small set of notes can do the task, a human newcomer probably can too.

gentl is an evaluation tool, not a coding agent; the code the agent writes is a by-product. There are two outputs: the reading effort (a number, mostly useful as a trend over doc changes) and a friction report from an evaluator (what was missing or wrong in the docs, and where the agent guessed).

Status: early. Only host mode is implemented, and you confirm each action before it runs.

## Install

Requires Node >= 20.

```
git clone https://github.com/magland/gentl
cd gentl
npm install
npm link        # puts `gentl` on your PATH
```

Set `OPENROUTER_API_KEY` in the environment or in a `.env` file in the directory you run from.

## Usage

```
gentl run TASK.md --host
gentl run -t "Clone https://github.com/owner/foo, install it and run its tests." --host
```

A task is plain text. It names the repos to clone and, where it matters, the tag or commit; the agent does the cloning itself.

Options:

- `--host`: run on this machine in a fresh temp directory. Required for now; a Docker sandbox will become the default.
- `--model M`: the agent's model, default `anthropic/claude-haiku-5.5`.
- `--evaluator-model M`: the evaluator's model, same default.
- `--base-url URL`: any OpenAI-compatible endpoint (default `https://openrouter.ai/api/v1`). The key in `OPENROUTER_API_KEY` is sent to it.
- `--max-turns N`: default 50.
- `--keep`: keep the temp workspace instead of deleting it.

### Host mode

The agent works in `work/` inside a fresh temp directory, with `HOME` set to a sibling `home/` so it does not see your git config, caches or credentials. Only a few environment variables are passed through (`PATH`, locale, proxies); API keys and tokens are not. Each command runs in a fresh bash shell in its own process group, with no input and a 300 s timeout. The workspace is deleted at the end unless `--keep` is given.

The agent can still reach anything on your machine that you can, so gentl shows each action and asks `ok? [y/n]` before running it. On `n` you can give a reason, which is passed back to the agent. Ctrl-C while a command runs stops that command (the agent is told); Ctrl-C at any other time ends the run, and the run directory is still written.

## How it works

Each turn the model sees only the system prompt, the task, its notes, and its last action with the result (shown once). It returns one JSON object:

```
{"notes": "...", "notes_edit": {"old": "...", "new": "..."}, "notes_append": "...", "action": {...}}
```

Only `action` is required. The notes are the agent's working memory, meant to mimic how much a person can hold in their head at once, so the agent is asked to keep them small. The notes operations are applied in order (rewrite, edit, append); leaving them out keeps the notes unchanged.

Actions:

- `run {cmd, max_chars?}`: bash in the working directory. stdout and stderr are combined. Output longer than `max_chars` (default 2000, at most 20000) is cut in the middle, keeping the head and tail.
- `write_file {path, content}` and `edit_file {path, old, new}` (`old` must occur exactly once).
- `ask {question}`: no one answers. The question is recorded as a gap in the docs, and the agent is told to decide from the docs and code.
- `finish {success, summary, friction?}`: the summary cites the evidence of success; `friction` is the agent's own account of what was missing or unclear in the docs.

With OpenRouter, gentl asks for structured output (a JSON schema) so responses parse reliably; if the endpoint rejects it, gentl falls back to plain text and parses the first JSON object that contains an `action`.

## Evaluation

After a run that finishes (or reaches the turn limit), gentl records the final state of the workspace: for each git repo, `git status`, the commits and `git diff` against its upstream, and untracked files; also any loose files in the working directory. Then an evaluator (one model call) reads the full log, with the parts of each result that the agent did not see marked as such, the questions asked, the agent's finish report and the final state. It writes:

- a verdict: did the agent actually accomplish the task, judged from the evidence rather than the agent's claim;
- a friction report: docs used, what was missing or wrong, where the agent guessed, signs of prior knowledge (commands or APIs it used that never appeared in anything it read), and the questions it asked.

The evaluator reads only the run directory, so a run can be evaluated again later, for example with another model:

```
gentl evaluate runs/<id> --evaluator-model anthropic/claude-sonnet-5.5
```

The evaluator's tokens are not counted as reading effort. Reading effort should be compared only among runs that the evaluator judged successful, with the same agent model.

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
