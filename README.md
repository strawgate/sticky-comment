# Sticky PR Comment

A GitHub Action that maintains a single sticky comment per PR with independently-updatable sections from multiple jobs or workflows. Zero dependencies.

Each section carries a status badge and optional body. The action merges all sections into one comment, re-rendering on every update.

## Features

- **One comment, many sections** — different jobs/workflows each own a named section
- **Status badges** — `success`, `failure`, `pending`, `warning`, `skipped`, `cancelled`
- **Three rendering styles** — `summary` (table + collapsed details), `full` (expanded), `status-only` (table only)
- **Auto-expand failures** — failed sections render with `<details open>`
- **Zero dependencies** — single JS file using Node built-ins
- **Multiple sticky comments** — use different `comment-id` values for separate comments on the same PR

## Quick start

```yaml
# Simplest — auto-creates the comment on first section update
- uses: strawgate/sticky-comment@v1
  with:
    section: lint
    status: success
    body: "All checks passed."
```

## Usage

### Mode 1: Init (explicit setup)

Create the comment upfront with a header and style, then update sections from later jobs:

```yaml
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: strawgate/sticky-comment@v1
        with:
          mode: init
          header: "CI Status"
          style: summary  # summary | full | status-only

  lint:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
      - uses: strawgate/sticky-comment@v1
        if: always()
        with:
          section: lint
          title: "Lint & Format"
          status: ${{ job.status }}
          body: "Lint completed."

  test:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: npm test > test-output.txt 2>&1
      - uses: strawgate/sticky-comment@v1
        if: always()
        with:
          section: test
          title: "Tests"
          status: ${{ job.status }}
          body-path: test-output.txt
```

### Mode 2: Auto (default)

Skip init — the comment is created with defaults when the first section arrives:

```yaml
- uses: strawgate/sticky-comment@v1
  with:
    section: build
    status: ${{ job.status }}
    title: "Build"
    body: |
      Built in ${{ steps.build.outputs.duration }}s
      Binary size: ${{ steps.build.outputs.size }}
```

## Rendered output

The `summary` style (default) produces:

| Check | Status |
|-------|--------|
| Lint  | :white_check_mark: Pass |
| Tests | :x: Fail |
| Build | :hourglass_flowing_sand: Running |

With collapsible `<details>` blocks per section. Failed sections auto-expand.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `token` | `${{ github.token }}` | GitHub token for API access |
| `mode` | `update` | `init` to create/configure, `update` to upsert a section |
| `comment-id` | `sticky-comment` | Logical name (allows multiple sticky comments per PR) |
| `issue-number` | *(auto-detected)* | PR or issue number |
| `header` | | Markdown heading at the top of the comment |
| `style` | `summary` | `summary`, `full`, or `status-only` |
| `section` | | Section identifier (required for update mode) |
| `title` | *(section id)* | Display title for the section |
| `status` | | `success`, `failure`, `pending`, `warning`, `skipped`, `cancelled` |
| `body` | | Section body content (markdown) |
| `body-path` | | Read body from this file instead |

## Outputs

| Output | Description |
|--------|-------------|
| `comment-id` | Numeric GitHub comment ID |
| `comment-url` | HTML URL of the comment |

## Concurrency

If two jobs update different sections at the same time, the last writer wins and may overwrite the other's update. Serialize with `needs:` dependencies or [`concurrency`](https://docs.github.com/en/actions/using-jobs/using-concurrency) groups.

## License

MIT
