# impact-analysis

Know the blast radius before you edit.

A Claude Code plugin that automatically analyzes file dependencies before every `Edit` or `Write` operation. Shows who depends on the file, what functions they use, and how risky the change is.

## What it does

- **Blast radius scoring** — ISOLATED / LOW / MODERATE / HIGH / CRITICAL based on dependent count
- **Dependency graph** — shows every file that imports the file you're editing, with exact function usage
- **Reverse impact** — shows what the file itself depends on (both directions of the graph)
- **Function severity** — distinguishes public API exports from internal helpers and private functions. Editing `_helper()` ≠ editing `publicAPI()` used by 12 files
- **TS path aliases** — resolves `@/components/...` paths from tsconfig.json
- **Change history** — tracks edit frequency per session, boosts risk score for repeatedly-edited files
- **Full path resolution** — no false positives from filename collisions (two `utils.js` in different dirs won't confuse it)

## Languages

JavaScript, TypeScript, JSX/TSX, Python, Go.

## Output example

```
impact-analysis: SFG_Utils.js | Blast radius: CRITICAL (7 dependents)
  DEPENDENTS (who breaks if I change):
    <- SFG_BSC_Checks.js uses: getTokenInfo, formatNative, checkHighTax
    <- scan-engine.js uses: getTokenInfo, formatSupply, sanitizeReason
  DEPENDENCIES (what I import):
    -> ethers (external)
  HIGH-RISK EXPORTS:
    HIGH getTokenInfo() -- public, used by 5 files
    HIGH checkHighTax() -- public, used by 4 files
  Exports: 19 public, 33 internal, 1 private
```

## Configuration

Create `.impactrc.json` in your project root, or add `"impactAnalysis"` section to `package.json`.

```json
{
  "extensions": [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".go"],
  "ignoreDirs": ["node_modules", ".git", "dist", "build"],
  "maxFiles": 500,
  "maxDepth": 10,
  "blastThresholds": { "low": 1, "moderate": 3, "high": 6 },
  "outputFormat": "text",
  "showReverse": true,
  "showSeverity": true,
  "showHistory": true
}
```

All fields optional. Defaults work for most projects.

| Option | Default | Description |
|--------|---------|-------------|
| `extensions` | js/ts/jsx/tsx/py/go | File types to analyze |
| `ignoreDirs` | node_modules, .git, dist... | Directories to skip |
| `maxFiles` | 500 | Max files to scan (performance guard) |
| `maxDepth` | 10 | Max directory depth |
| `blastThresholds` | 1/3/6 | Dependent count → risk level boundaries |
| `outputFormat` | "text" | "text" or "json" for machine-readable output |
| `showReverse` | true | Show what the file depends on |
| `showSeverity` | true | Show per-function risk analysis |
| `showHistory` | true | Track edit frequency, boost score for hot files |

## Install

```bash
claude plugin install impact-analysis
```

## How it works

Runs as a `PreToolUse` hook on `Edit` and `Write` tools. Parses the project's import graph, resolves paths (including TS aliases), analyzes export visibility, and outputs a risk report. Informational only — never blocks your edits.

Shows report once per file per session to avoid noise.

## Authors

Built by **OveR** ([@OveR_XBT](https://x.com/OveR_XBT)) & **Claude** (Anthropic).

Part of the [SFG Engine](https://x.com/SFGEngine) ecosystem.
