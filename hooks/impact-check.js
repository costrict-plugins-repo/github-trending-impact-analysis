#!/usr/bin/env node

// impact-analysis v2.0: PreToolUse hook for Edit/Write
// Full dependency graph with blast radius scoring, function severity,
// reverse impact, TS path aliases, change history, configurable.
// Informational only (exit 0).

const fs = require('fs');
const path = require('path');

// ============ DEFAULTS ============

const DEFAULTS = {
  extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go'],
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.claude', 'vendor'],
  maxFiles: 500,
  maxDepth: 10,
  blastThresholds: { low: 1, moderate: 3, high: 6 },
  outputFormat: 'text',
  showReverse: true,
  showSeverity: true,
  showHistory: true,
};

// ============ CONFIG (.impactrc.json) ============

function loadConfig(root) {
  const configNames = ['.impactrc.json', '.impactrc'];
  for (const name of configNames) {
    const fp = path.join(root, name);
    try {
      if (fs.existsSync(fp)) {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        return { ...DEFAULTS, ...raw };
      }
    } catch {}
  }

  // Check package.json "impactAnalysis" section
  const pkgPath = path.join(root, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.impactAnalysis) {
        return { ...DEFAULTS, ...pkg.impactAnalysis };
      }
    }
  } catch {}

  return DEFAULTS;
}

// ============ TS PATH ALIASES ============

function loadTsAliases(root) {
  const aliases = {};
  const tsConfigs = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];

  for (const name of tsConfigs) {
    const fp = path.join(root, name);
    try {
      if (!fs.existsSync(fp)) continue;
      let raw = fs.readFileSync(fp, 'utf-8');
      // Strip comments (// and /* */) for JSON parse
      raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(raw);
      const paths = config.compilerOptions?.paths;
      const baseUrl = config.compilerOptions?.baseUrl || '.';
      if (!paths) continue;

      for (const [alias, targets] of Object.entries(paths)) {
        if (!targets || !targets.length) continue;
        // "@/*" -> target "./src/*"
        const aliasPrefix = alias.replace(/\*$/, '');
        const targetPath = targets[0].replace(/\*$/, '');
        aliases[aliasPrefix] = path.resolve(root, baseUrl, targetPath);
      }
      break; // Use first found config
    } catch {}
  }

  return aliases;
}

// Resolve aliased import to absolute path
function resolveAlias(importPath, aliases) {
  for (const [prefix, targetDir] of Object.entries(aliases)) {
    if (importPath.startsWith(prefix)) {
      const rest = importPath.slice(prefix.length);
      return path.join(targetDir, rest);
    }
  }
  return null;
}

// ============ STATE & HISTORY ============

const SESSION_ID = process.env.SESSION_ID || 'default';
const STATE_DIR = path.join(process.env.HOME || '/root', '.claude');
const STATE_FILE = path.join(STATE_DIR, `impact_state_${SESSION_ID}.json`);

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { seen: {}, edits: {} };
}

function saveState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function trackEdit(filePath) {
  const state = loadState();
  if (!state.edits) state.edits = {};

  // Already reported this session?
  if (state.seen[filePath]) {
    // Track edit count but don't show report again
    state.edits[filePath] = (state.edits[filePath] || 0) + 1;
    saveState(state);
    return { alreadySeen: true, editCount: state.edits[filePath] };
  }

  state.seen[filePath] = Date.now();
  state.edits[filePath] = (state.edits[filePath] || 0) + 1;
  saveState(state);
  return { alreadySeen: false, editCount: state.edits[filePath] };
}

function getEditCount(filePath) {
  const state = loadState();
  return state.edits?.[filePath] || 0;
}

// Cleanup old state files (random 10% trigger)
function cleanupOldState() {
  if (Math.random() > 0.1) return;
  try {
    const files = fs.readdirSync(STATE_DIR);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith('impact_state_')) continue;
      const fp = path.join(STATE_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
}

// ============ FILE DISCOVERY ============

function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function collectFiles(root, config) {
  const files = [];
  const ignoreDirs = new Set(config.ignoreDirs);

  function walk(dir, depth) {
    if (depth > config.maxDepth || files.length >= config.maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (files.length >= config.maxFiles) return;
      if (ignoreDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (config.extensions.some(ext => entry.name.endsWith(ext))) {
        files.push(full);
      }
    }
  }

  walk(root, 0);
  return files;
}

// ============ IMPORT RESOLUTION (full path matching) ============

// Resolve an import string to an absolute file path
function resolveImportPath(importStr, sourceFile, root, aliases) {
  // TS path aliases: @/..., ~/..., etc
  const aliasResolved = resolveAlias(importStr, aliases);
  if (aliasResolved) {
    return findFileWithExtensions(aliasResolved);
  }

  // Relative imports: ./foo, ../bar
  if (importStr.startsWith('.')) {
    const sourceDir = path.dirname(sourceFile);
    const resolved = path.resolve(sourceDir, importStr);
    return findFileWithExtensions(resolved);
  }

  // Go package imports
  if (sourceFile.endsWith('.go')) {
    const goResolved = path.join(root, importStr.replace(/^.*\//, ''));
    return findFileWithExtensions(goResolved);
  }

  // Python relative: from foo import bar (no dot prefix)
  if (sourceFile.endsWith('.py')) {
    const pyResolved = path.join(path.dirname(sourceFile), importStr.replace(/\./g, '/'));
    return findFileWithExtensions(pyResolved);
  }

  return null;
}

function findFileWithExtensions(basePath) {
  // Exact match with extension
  if (fs.existsSync(basePath) && !fs.statSync(basePath).isDirectory()) return basePath;

  // Try adding extensions
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go'];
  for (const ext of exts) {
    const withExt = basePath + ext;
    if (fs.existsSync(withExt)) return withExt;
  }

  // Try index file in directory
  const indexExts = ['.ts', '.tsx', '.js', '.jsx'];
  for (const ext of indexExts) {
    const indexFile = path.join(basePath, 'index' + ext);
    if (fs.existsSync(indexFile)) return indexFile;
  }

  return null;
}

// Extract all import paths from a file
function extractImports(content, filePath) {
  const imports = [];

  if (filePath.endsWith('.py')) {
    // Python: from X import ..., import X
    const pyFrom = content.matchAll(/^from\s+([\w.]+)\s+import/gm);
    for (const m of pyFrom) imports.push(m[1]);
    const pyImport = content.matchAll(/^import\s+([\w.]+)/gm);
    for (const m of pyImport) imports.push(m[1]);
  } else if (filePath.endsWith('.go')) {
    // Go: import "pkg" or import ( "pkg" )
    const goSingle = content.matchAll(/import\s+"([^"]+)"/g);
    for (const m of goSingle) imports.push(m[1]);
    const goBlock = content.match(/import\s*\(([^)]+)\)/s);
    if (goBlock) {
      const pkgs = goBlock[1].matchAll(/"([^"]+)"/g);
      for (const m of pkgs) imports.push(m[1]);
    }
  } else {
    // JS/TS: require('...'), import ... from '...', import '...'
    const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const importFromRe = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

    let m;
    while ((m = requireRe.exec(content)) !== null) imports.push(m[1]);
    while ((m = importFromRe.exec(content)) !== null) imports.push(m[1]);
  }

  return [...new Set(imports)];
}

// Check if a file imports the target (full path resolution)
function fileImportsTarget(sourceFile, sourceContent, targetFile, root, aliases) {
  const importPaths = extractImports(sourceContent, sourceFile);

  for (const imp of importPaths) {
    const resolved = resolveImportPath(imp, sourceFile, root, aliases);
    if (resolved && path.resolve(resolved) === path.resolve(targetFile)) {
      return imp;
    }
  }

  return null;
}

// ============ EXPORT & SEVERITY ANALYSIS ============

function analyzeExports(content, ext) {
  const exported = [];

  if (['.py'].includes(ext)) {
    for (const m of content.matchAll(/^(def|class)\s+(\w+)/gm)) {
      const isPrivate = m[2].startsWith('_');
      exported.push({ name: m[2], type: isPrivate ? 'private' : 'public', kind: m[1] === 'class' ? 'class' : 'function' });
    }
    return exported;
  }

  // JS/TS: Collect ALL functions/classes defined in file
  const allDefs = new Map();

  for (const m of content.matchAll(/(?:async\s+)?function\s+(\w+)/g)) {
    allDefs.set(m[1], 'function');
  }
  for (const m of content.matchAll(/class\s+(\w+)/g)) {
    allDefs.set(m[1], 'class');
  }
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) {
    if (!allDefs.has(m[1])) allDefs.set(m[1], 'const');
  }

  // Determine what's exported
  const exportedNames = new Set();

  // module.exports = { a, b, c }
  const moduleExports = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (moduleExports) {
    const names = moduleExports[1].match(/\b(\w+)\b/g);
    if (names) {
      for (const n of names) {
        if (!['async', 'function', 'class', 'const', 'let', 'var', 'true', 'false'].includes(n)) {
          exportedNames.add(n);
        }
      }
    }
  }

  // module.exports = ClassName
  const moduleExportsSingle = content.match(/module\.exports\s*=\s*(\w+)\s*;/);
  if (moduleExportsSingle) exportedNames.add(moduleExportsSingle[1]);

  // exports.name = ...
  for (const m of content.matchAll(/exports\.(\w+)\s*=/g)) exportedNames.add(m[1]);

  // export function/class/const
  for (const m of content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g)) {
    exportedNames.add(m[1]);
  }

  // export default identifier
  for (const m of content.matchAll(/export\s+default\s+(\w+)\s*;/g)) {
    exportedNames.add(m[1]);
  }

  // Build result with severity
  for (const [name, kind] of allDefs) {
    const isExported = exportedNames.has(name);
    const isPrivateConvention = name.startsWith('_');
    const type = isExported ? 'public' : (isPrivateConvention ? 'private' : 'internal');
    exported.push({ name, type, kind });
  }

  // Add exported names not found as defs (re-exports, etc)
  for (const name of exportedNames) {
    if (!allDefs.has(name)) {
      exported.push({ name, type: 'public', kind: 'unknown' });
    }
  }

  return exported;
}

function functionSeverity(funcName, funcType, dependentCount) {
  if (funcType === 'private') return 'LOW';
  if (funcType === 'internal') return dependentCount > 0 ? 'MODERATE' : 'LOW';
  if (dependentCount === 0) return 'LOW';
  if (dependentCount <= 2) return 'MODERATE';
  if (dependentCount <= 5) return 'HIGH';
  return 'CRITICAL';
}

// ============ REVERSE IMPACT ============

function findDependencies(targetFile, targetContent, files, root, aliases) {
  const imports = extractImports(targetContent, targetFile);
  const dependencies = [];

  for (const imp of imports) {
    const resolved = resolveImportPath(imp, targetFile, root, aliases);
    if (!resolved) continue;
    if (!files.includes(resolved)) continue;

    let depContent;
    try { depContent = fs.readFileSync(resolved, 'utf-8'); } catch { continue; }
    const depExports = analyzeExports(depContent, path.extname(resolved));
    const publicNames = depExports.filter(e => e.type === 'public').map(e => e.name);

    const used = [];
    for (const name of publicNames) {
      if (new RegExp(`\\b${name}\\b`).test(targetContent)) used.push(name);
    }

    dependencies.push({
      file: path.relative(root, resolved),
      importPath: imp,
      uses: used,
    });
  }

  return dependencies;
}

// ============ BLAST RADIUS ============

function calculateBlastRadius(dependents, config) {
  const t = config.blastThresholds;
  const count = dependents.length;
  if (count === 0) return { score: 0, level: 'ISOLATED' };
  if (count <= t.low) return { score: 1, level: 'LOW' };
  if (count <= t.moderate) return { score: 2, level: 'MODERATE' };
  if (count <= t.high) return { score: 3, level: 'HIGH' };
  return { score: 4, level: 'CRITICAL' };
}

function applyRecidivistBoost(blast, editCount) {
  if (editCount < 3) return blast;
  const levels = ['ISOLATED', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
  const idx = levels.indexOf(blast.level);
  const boost = editCount >= 5 ? 2 : 1;
  const newIdx = Math.min(idx + boost, levels.length - 1);
  return { score: newIdx, level: levels[newIdx], boosted: true, editCount };
}

// ============ OUTPUT ============

function formatText(report) {
  const lines = [];
  const blastLabel = report.blast.boosted
    ? `${report.blast.level} (${report.dependents.length} dep, edited ${report.blast.editCount}x this session)`
    : `${report.blast.level} (${report.dependents.length} dependents)`;

  lines.push(`impact-analysis: ${report.file} | Blast radius: ${blastLabel}`);

  if (report.dependents.length > 0) {
    lines.push(`  DEPENDENTS (who breaks if I change):`);
    for (const dep of report.dependents) {
      const usedStr = dep.uses.length > 0 ? ` uses: ${dep.uses.join(', ')}` : '';
      lines.push(`    <- ${dep.file}${usedStr}`);
    }
  }

  if (report.dependencies && report.dependencies.length > 0) {
    lines.push(`  DEPENDENCIES (what I import):`);
    for (const dep of report.dependencies) {
      const usedStr = dep.uses.length > 0 ? ` uses: ${dep.uses.join(', ')}` : '';
      lines.push(`    -> ${dep.file}${usedStr}`);
    }
  }

  if (report.severity && report.severity.length > 0) {
    const critical = report.severity.filter(s => s.severity === 'CRITICAL' || s.severity === 'HIGH');
    if (critical.length > 0) {
      lines.push(`  HIGH-RISK EXPORTS:`);
      for (const s of critical) {
        lines.push(`    ${s.severity} ${s.name}() -- ${s.type}, used by ${s.usedBy} files`);
      }
    }
  }

  if (report.exports && report.exports.length > 0) {
    const pub = report.exports.filter(e => e.type === 'public');
    const internal = report.exports.filter(e => e.type === 'internal');
    const priv = report.exports.filter(e => e.type === 'private');
    const parts = [];
    if (pub.length) parts.push(`${pub.length} public`);
    if (internal.length) parts.push(`${internal.length} internal`);
    if (priv.length) parts.push(`${priv.length} private`);
    lines.push(`  Exports: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

function formatJSON(report) {
  return JSON.stringify(report, null, 2);
}

// ============ MAIN ============

async function main() {
  cleanupOldState();

  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const root = findProjectRoot();
  const config = loadConfig(root);

  const ext = path.extname(filePath);
  if (!config.extensions.includes(ext)) process.exit(0);

  const { alreadySeen, editCount } = trackEdit(filePath);
  if (alreadySeen) process.exit(0);

  if (!fs.existsSync(filePath)) process.exit(0);

  const files = collectFiles(root, config);
  const aliases = loadTsAliases(root);
  const targetRelFromRoot = path.relative(root, filePath);

  let targetContent;
  try { targetContent = fs.readFileSync(filePath, 'utf-8'); } catch { process.exit(0); }

  const exports = analyzeExports(targetContent, ext);

  // Find dependents (who imports this file)
  const dependents = [];
  for (const file of files) {
    if (file === filePath) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const importMatch = fileImportsTarget(file, content, filePath, root, aliases);
    if (!importMatch) continue;

    const publicNames = exports.filter(e => e.type === 'public').map(e => e.name);
    const used = [];
    for (const name of publicNames) {
      if (new RegExp(`\\b${name}\\b`).test(content)) used.push(name);
    }

    dependents.push({
      file: path.relative(root, file),
      importPath: importMatch,
      uses: used,
    });
  }

  // Reverse impact
  let dependencies = [];
  if (config.showReverse) {
    dependencies = findDependencies(filePath, targetContent, files, root, aliases);
  }

  // Function severity
  let severity = [];
  if (config.showSeverity && exports.length > 0) {
    for (const exp of exports.filter(e => e.type === 'public')) {
      let usedByCount = 0;
      for (const dep of dependents) {
        if (dep.uses.includes(exp.name)) usedByCount++;
      }
      const sev = functionSeverity(exp.name, exp.type, usedByCount);
      if (sev !== 'LOW') {
        severity.push({ name: exp.name, type: exp.type, kind: exp.kind, severity: sev, usedBy: usedByCount });
      }
    }
    severity.sort((a, b) => {
      const order = { CRITICAL: 0, HIGH: 1, MODERATE: 2 };
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    });
  }

  // Blast radius with recidivist boost
  let blast = calculateBlastRadius(dependents, config);
  if (config.showHistory) {
    const totalEdits = getEditCount(filePath);
    blast = applyRecidivistBoost(blast, totalEdits);
  }

  if (dependents.length === 0 && dependencies.length === 0) process.exit(0);

  const report = {
    file: targetRelFromRoot,
    blast,
    dependents,
    dependencies: config.showReverse ? dependencies : undefined,
    exports,
    severity: severity.length > 0 ? severity : undefined,
  };

  const output = config.outputFormat === 'json' ? formatJSON(report) : formatText(report);
  process.stderr.write(output + '\n');
  process.exit(0);
}

main().catch(() => process.exit(0));
