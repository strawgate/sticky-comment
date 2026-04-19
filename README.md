# Sticky PR Comment

A GitHub Action that maintains a single sticky comment per PR with independently-updatable sections from multiple jobs or workflows.

Each section carries a status badge and optional body. The action merges all sections into one comment, re-rendering on every update. Concurrent writers are handled with retry + timestamp-based conflict resolution.

## Features

- **One comment, many sections** — different jobs/workflows each own a named section
- **Status badges** — `success`, `failure`, `pending`, `warning`, `skipped`, `cancelled`, `info`
- **Three rendering styles** — `summary` (collapsed details), `full` (expanded), `status-only` (table only)
- **Auto-expand failures** — failed sections render with `<details open>`
- **Conflict resolution** — retry with random 1-5s backoff; timestamp ordering prevents stale overwrites
- **Multiple sticky comments** — use different `comment-id` values for separate comments on the same PR
- **Zero runtime dependencies** — bundled with ncc into a single file

## Quick start

```yaml
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
| `status` | | `success`, `failure`, `pending`, `warning`, `skipped`, `cancelled`, `info` |
| `body` | | Section body content (markdown) |
| `body-path` | | Read body from this file instead |

## Outputs

| Output | Description |
|--------|-------------|
| `comment-id` | Numeric GitHub comment ID |
| `comment-url` | HTML URL of the comment |

## Conflict resolution

When multiple jobs update different sections concurrently, writes can collide. The action handles this automatically:

1. After each write, reads the comment back to verify the section survived
2. If overwritten by another writer, sleeps 1-5s (random) and retries up to 3 times
3. Each retry re-reads the latest state, preserving the other writer's sections
4. Every section carries a timestamp — a stale retry never overwrites a newer update

For sequential jobs, no special handling is needed. For parallel jobs, the retry mechanism handles typical contention (tested with 10 concurrent writers at 100% success, 100 concurrent writers at 99%).

## License

MIT
