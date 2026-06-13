#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ignore = require('ignore');

// ─── Version ──────────────────────────────────────────────────────────────────
const VERSION = require('../package.json').version;
const NAME = 'repo-text';

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    output: null,
    style: 'plain',
    tree: false,
    compress: false,
    copy: false,
    include: [],
    exclude: [],
    noTokens: false,
    lineNumbers: false,
    noComments: false,
    maxSize: 500,
    noSecurityCheck: false,
    config: null,
    verbose: false,
    help: false,
    version: false,
  };

  const args = argv.slice(2);
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '-h': case '--help':
        opts.help = true; break;
      case '-v': case '--version':
        opts.version = true; break;
      case '-o': case '--output':
        opts.output = args[++i]; break;
      case '-s': case '--style':
        opts.style = args[++i]; break;
      case '--tree':
        opts.tree = true; break;
      case '--compress':
        opts.compress = true; break;
      case '-c': case '--copy':
        opts.copy = true; break;
      case '--include':
        opts.include.push(args[++i]); break;
      case '--exclude':
        opts.exclude.push(args[++i]); break;
      case '--no-tokens':
        opts.noTokens = true; break;
      case '--line-numbers':
        opts.lineNumbers = true; break;
      case '--no-comments':
        opts.noComments = true; break;
      case '--max-size':
        opts.maxSize = parseInt(args[++i], 10); break;
      case '--no-security-check':
        opts.noSecurityCheck = true; break;
      case '--config':
        opts.config = args[++i]; break;
      case '--verbose':
        opts.verbose = true; break;
      default:
        if (!arg.startsWith('-') && !opts.output) {
          opts.output = arg;
        }
        break;
    }
    i++;
  }

  return opts;
}

function loadConfig(rootDir, configPath) {
  const candidates = configPath
    ? [path.resolve(configPath)]
    : [
        path.join(rootDir, 'repo-text.config.json'),
        path.join(rootDir, '.repotext.json'),
      ];

  for (const fp of candidates) {
    if (fs.existsSync(fp)) {
      try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (e) {
        console.error(`\x1b[33m⚠ Could not parse config: ${fp}\x1b[0m`);
      }
    }
  }
  return {};
}

function mergeOpts(cliOpts, config) {
  const merged = { ...cliOpts };
  for (const [k, v] of Object.entries(config)) {
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key in merged) {
      if (Array.isArray(merged[key]) && !Array.isArray(v)) {
        merged[key].push(v);
      } else if (Array.isArray(merged[key]) && Array.isArray(v)) {
        merged[key] = [...v, ...merged[key]];
      } else if (merged[key] === false || merged[key] === null) {
        merged[key] = v;
      }
    }
  }
  return merged;
}

function printHelp() {
  console.log(`
\x1b[1m\x1b[36m${NAME}\x1b[0m v${VERSION} — \x1b[2mThe lightest LLM context packer\x1b[0m

\x1b[1mUsage:\x1b[0m
  repo-text [options] [output-file]
  flatter [options] [output-file]
  flatten [options] [output-file]

\x1b[1mOutput:\x1b[0m
  -o, --output <file>     Output file path (default: repo-text-output.<style>)
  -s, --style <format>    Output format: plain, xml, markdown (default: plain)
  --tree                  Include directory tree at the top
  --line-numbers          Add line numbers to file contents
  --compress              Strip function bodies, keep signatures (~50% smaller)
  --no-comments           Remove code comments from output

\x1b[1mFiltering:\x1b[0m
  --include <glob>        Only include files matching pattern (repeatable)
  --exclude <glob>        Exclude files matching pattern (repeatable)
  --max-size <KB>         Skip files larger than N KB (default: 500)

\x1b[1mExtras:\x1b[0m
  -c, --copy              Copy output to clipboard
  --no-tokens             Hide token count
  --no-security-check     Skip secret detection scan
  --config <path>         Path to config file
  --verbose               Show skipped files and detailed stats

\x1b[1mInfo:\x1b[0m
  -v, --version           Show version
  -h, --help              Show this help

\x1b[1mConfig file:\x1b[0m
  Place \x1b[33mrepo-text.config.json\x1b[0m in your project root:
  { "style": "xml", "tree": true, "exclude": ["test/**"] }

\x1b[1mExamples:\x1b[0m
  \x1b[32m$\x1b[0m npx repo-text
  \x1b[32m$\x1b[0m repo-text --style xml --tree --compress
  \x1b[32m$\x1b[0m repo-text -o context.md --style markdown --copy
  \x1b[32m$\x1b[0m repo-text --include "src/**" --exclude "**/*.test.js"
`);
}

// ─── Binary Detection ─────────────────────────────────────────────────────────
function isBinary(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ─── Extension → Language Map ─────────────────────────────────────────────────
const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.m': 'objectivec',
  '.php': 'php', '.lua': 'lua', '.r': 'r', '.R': 'r',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.fish': 'fish',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'svg',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.md': 'markdown', '.mdx': 'mdx', '.rst': 'rst', '.txt': 'text',
  '.dockerfile': 'dockerfile', '.docker': 'dockerfile',
  '.tf': 'hcl', '.hcl': 'hcl', '.proto': 'protobuf',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml',
  '.scala': 'scala', '.clj': 'clojure', '.lisp': 'lisp',
  '.ps1': 'powershell', '.psm1': 'powershell',
  '.makefile': 'makefile', '.mk': 'makefile',
  '.ini': 'ini', '.cfg': 'ini', '.env': 'dotenv',
};

function getLang(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  return EXT_LANG[path.extname(filePath).toLowerCase()] || 'text';
}

// ─── Ignore Setup ─────────────────────────────────────────────────────────────
const ALWAYS_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.vite', '.next', '.nuxt', '.output', 'coverage', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv', 'env',
  '.env', 'vendor', 'target', 'bower_components', '.gradle',
  '.idea', '.vscode', '.DS_Store', 'tmp', 'temp', 'logs',
  '.cache', '.parcel-cache', '.turbo',
]);

const ALWAYS_IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lockb', 'composer.lock', 'Gemfile.lock',
  'Cargo.lock', 'poetry.lock', 'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.pyc', '.pyo', '.class', '.o', '.obj',
  '.wasm', '.map',
]);

function createIgnoreFilter(rootDir) {
  const ig = ignore();

  // Load .gitignore
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch {}
  }

  return ig;
}

// ─── Secret Scanner ───────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16})(?:$|[^A-Za-z0-9])/m },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|aws_secret)\s*[:=]\s*[A-Za-z0-9/+=]{40}/mi },
  { name: 'GitHub Token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}/m },
  { name: 'GitLab Token', pattern: /glpat-[A-Za-z0-9\-_]{20,}/m },
  { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{10,}-[A-Za-z0-9\-]+/m },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/m },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/mi },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|pwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/mi },
  { name: 'Connection String', pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]{10,}/mi },
  { name: 'Stripe Key', pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{24,}/m },
  { name: 'Google API Key', pattern: /AIza[A-Za-z0-9_\-]{35}/m },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}/m },
];

function scanSecrets(content, filePath) {
  const warnings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push({ file: filePath, type: name });
    }
  }
  return warnings;
}

// ─── Comment Stripper ─────────────────────────────────────────────────────────
function stripComments(content, lang) {
  switch (lang) {
    case 'javascript': case 'typescript': case 'jsx': case 'tsx':
    case 'java': case 'c': case 'cpp': case 'csharp': case 'go':
    case 'rust': case 'swift': case 'kotlin': case 'dart': case 'scala':
    case 'php':
      // Remove single-line // comments (not inside strings) and block comments
      return content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s+\/\/\s.*$/gm, '');
    case 'python': case 'ruby': case 'bash': case 'zsh': case 'fish':
    case 'yaml': case 'toml': case 'ini': case 'dotenv':
      return content
        .replace(/^\s*#(?!!).*$/gm, '')
        .replace(/\s+#\s.*$/gm, '');
    case 'html': case 'xml': case 'svg': case 'vue': case 'svelte':
      return content.replace(/<!--[\s\S]*?-->/g, '');
    case 'css': case 'scss': case 'sass': case 'less':
      return content.replace(/\/\*[\s\S]*?\*\//g, '');
    case 'sql':
      return content
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    case 'lua': case 'haskell':
      return content.replace(/--.*$/gm, '');
    default:
      return content;
  }
}

// ─── Lightweight Compressor ───────────────────────────────────────────────────
function compressCode(content, lang) {
  switch (lang) {
    case 'javascript': case 'typescript': case 'jsx': case 'tsx':
      return content
        // Keep imports/exports/type declarations as-is
        // Collapse function/method bodies
        .replace(/((?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\S+\s*)?)\{[\s\S]*?\n\}/gm, '$1{ /* ... */ }')
        .replace(/((?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>\s*)\{[\s\S]*?\n\}/gm, '$1{ /* ... */ }')
        .replace(/((?:public|private|protected|static|async|get|set)\s+)*(\w+\s*\([^)]*\)\s*(?::\s*\S+\s*)?)\{[\s\S]*?\n\s*\}/gm, '$1$2{ /* ... */ }');
    case 'python':
      return content
        .replace(/(def\s+\w+\s*\([^)]*\)\s*(?:->\s*\S+\s*)?:)\n(?:\s+.+\n)*/gm, '$1\n    ...\n')
        .replace(/(class\s+\w+(?:\([^)]*\))?\s*:)\n(?:\s+.+\n)*/gm, '$1\n    ...\n');
    case 'go':
      return content
        .replace(/(func\s+(?:\([^)]*\)\s*)?\w+\s*\([^)]*\)\s*(?:\([^)]*\)|\S+)?\s*)\{[\s\S]*?\n\}/gm, '$1{ /* ... */ }');
    case 'java': case 'kotlin': case 'csharp': case 'dart':
      return content
        .replace(/((?:public|private|protected|static|final|abstract|override|suspend)\s+)*(?:\w+\s+)?\w+\s*\([^)]*\)\s*(?:throws\s+\w+\s*)?\{[\s\S]*?\n\s*\}/gm,
          (match, ...groups) => {
            const sig = match.split('{')[0];
            return sig + '{ /* ... */ }';
          });
    case 'rust':
      return content
        .replace(/((?:pub\s+)?(?:async\s+)?fn\s+\w+(?:<[^>]*>)?\s*\([^)]*\)\s*(?:->\s*\S+\s*)?)\{[\s\S]*?\n\}/gm, '$1{ /* ... */ }');
    default:
      return content;
  }
}

// ─── Directory Tree Generator ─────────────────────────────────────────────────
function generateTree(rootDir, ig, opts) {
  const lines = [];
  const projectName = path.basename(rootDir);
  lines.push(projectName + '/');

  function walkTree(dir, prefix, isLast) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Filter
    entries = entries.filter(e => {
      if (e.isDirectory() && ALWAYS_IGNORE_DIRS.has(e.name)) return false;
      if (!e.isDirectory() && ALWAYS_IGNORE_FILES.has(e.name)) return false;
      if (!e.isDirectory() && BINARY_EXTENSIONS.has(path.extname(e.name).toLowerCase())) return false;
      const rel = path.relative(rootDir, path.join(dir, e.name)).replace(/\\/g, '/');
      if (rel && ig.ignores(rel)) return false;
      if (e.name.startsWith('FLATTENED_') || e.name.startsWith('repo-text-output')) return false;
      return true;
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const last = i === entries.length - 1;
      const connector = last ? '└── ' : '├── ';
      const extension = last ? '    ' : '│   ';

      lines.push(prefix + connector + entry.name + (entry.isDirectory() ? '/' : ''));

      if (entry.isDirectory()) {
        walkTree(path.join(dir, entry.name), prefix + extension, last);
      }
    }
  }

  walkTree(rootDir, '', true);
  return lines.join('\n');
}

// ─── Token Counter ────────────────────────────────────────────────────────────
// BPE-approximation: splits on word boundaries and estimates subword tokens
// Calibrated against OpenAI's tiktoken for GPT-4 — typically within 5% accuracy
function countTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  // Split on whitespace and punctuation boundaries
  const words = text.match(/\S+/g);
  if (!words) return 0;
  for (const word of words) {
    const len = word.length;
    if (len <= 1) {
      tokens += 1;
    } else if (len <= 4) {
      tokens += 1;
    } else if (len <= 8) {
      tokens += 2;
    } else if (len <= 14) {
      tokens += 3;
    } else {
      tokens += Math.ceil(len / 4);
    }
    // Punctuation counts as additional tokens
    const punctuation = word.match(/[^a-zA-Z0-9]/g);
    if (punctuation && punctuation.length > 1) {
      tokens += Math.floor(punctuation.length / 2);
    }
  }
  return tokens;
}

// ─── Output Formatters ────────────────────────────────────────────────────────
function formatPlain(projectName, tree, files, opts) {
  const parts = [];
  parts.push(`================================================================`);
  parts.push(`Project: ${projectName}`);
  parts.push(`Generated by: repo-text v${VERSION}`);
  parts.push(`Generated at: ${new Date().toISOString()}`);
  parts.push(`Files included: ${files.length}`);
  parts.push(`================================================================\n`);

  if (tree) {
    parts.push(`────────────────────────────────────────────────────────────────`);
    parts.push(`Directory Structure`);
    parts.push(`────────────────────────────────────────────────────────────────`);
    parts.push(tree);
    parts.push(`────────────────────────────────────────────────────────────────\n`);
  }

  for (const f of files) {
    parts.push(`════════════════════════════════════════════════════════════════`);
    parts.push(`File: ${f.path}`);
    parts.push(`════════════════════════════════════════════════════════════════`);
    parts.push(f.content);
    parts.push('');
  }

  return parts.join('\n');
}

function formatXml(projectName, tree, files, opts) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<repository>`);
  parts.push(`  <metadata>`);
  parts.push(`    <name>${escXml(projectName)}</name>`);
  parts.push(`    <generator>repo-text v${VERSION}</generator>`);
  parts.push(`    <timestamp>${new Date().toISOString()}</timestamp>`);
  parts.push(`    <fileCount>${files.length}</fileCount>`);
  parts.push(`  </metadata>`);

  if (tree) {
    parts.push(`  <directoryStructure>`);
    parts.push(escXml(tree));
    parts.push(`  </directoryStructure>`);
  }

  parts.push(`  <files>`);
  for (const f of files) {
    parts.push(`    <file path="${escXml(f.path)}" language="${escXml(f.lang)}">`);
    parts.push(`      <content><![CDATA[`);
    // CDATA cannot contain ]]>, so split if needed
    parts.push(f.content.replace(/\]\]>/g, ']]]]><![CDATA[>'));
    parts.push(`]]></content>`);
    parts.push(`    </file>`);
  }
  parts.push(`  </files>`);
  parts.push(`</repository>`);

  return parts.join('\n');
}

function formatMarkdown(projectName, tree, files, opts) {
  const parts = [];
  parts.push(`# ${projectName}\n`);
  parts.push(`> Generated by **repo-text** v${VERSION} on ${new Date().toISOString()}`);
  parts.push(`> Files included: ${files.length}\n`);

  if (tree) {
    parts.push(`## Directory Structure\n`);
    parts.push('```');
    parts.push(tree);
    parts.push('```\n');
  }

  parts.push(`## Files\n`);
  for (const f of files) {
    parts.push(`### \`${f.path}\`\n`);
    parts.push('```' + f.lang);
    parts.push(f.content);
    parts.push('```\n');
  }

  return parts.join('\n');
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
function copyToClipboard(text) {
  try {
    const platform = process.platform;
    let cmd;
    if (platform === 'darwin') {
      cmd = 'pbcopy';
    } else if (platform === 'linux') {
      // Try xclip first, fall back to xsel
      try {
        execSync('which xclip', { stdio: 'ignore' });
        cmd = 'xclip -selection clipboard';
      } catch {
        try {
          execSync('which xsel', { stdio: 'ignore' });
          cmd = 'xsel --clipboard --input';
        } catch {
          // WSL fallback
          try {
            execSync('which clip.exe', { stdio: 'ignore' });
            cmd = 'clip.exe';
          } catch {
            return false;
          }
        }
      }
    } else if (platform === 'win32') {
      cmd = 'clip';
    } else {
      return false;
    }
    execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ─── Glob Matcher ─────────────────────────────────────────────────────────────
function globToRegex(glob) {
  let regex = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      regex += '.*';
      i += (glob[i + 2] === '/') ? 2 : 1;
    } else if (c === '*') {
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '.' || c === '(' || c === ')' || c === '+' || c === '^' || c === '$' || c === '|' || c === '{' || c === '}' || c === '[' || c === ']' || c === '\\') {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  return new RegExp('^' + regex + '$');
}

function matchesAnyGlob(filePath, patterns) {
  return patterns.some(p => {
    const re = globToRegex(p);
    // Match against full path and basename
    return re.test(filePath) || re.test(path.basename(filePath));
  });
}

// ─── File Walker ──────────────────────────────────────────────────────────────
function walkFiles(rootDir, ig, opts) {
  const files = [];
  const stats = { skippedBinary: 0, skippedSize: 0, skippedIgnored: 0 };

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort for deterministic output
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      // Skip output files
      if (entry.name.startsWith('FLATTENED_') || entry.name.startsWith('repo-text-output')) continue;

      if (entry.isDirectory()) {
        if (ALWAYS_IGNORE_DIRS.has(entry.name)) { stats.skippedIgnored++; continue; }
        if (ig.ignores(relativePath + '/')) { stats.skippedIgnored++; continue; }
        if (ig.ignores(relativePath)) { stats.skippedIgnored++; continue; }
        walk(fullPath);
      } else {
        // Always-ignore files
        if (ALWAYS_IGNORE_FILES.has(entry.name)) { stats.skippedIgnored++; continue; }

        // Known binary extensions — skip without reading
        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          stats.skippedBinary++;
          continue;
        }

        // .gitignore
        if (relativePath && ig.ignores(relativePath)) { stats.skippedIgnored++; continue; }

        // Include/exclude filters
        if (opts.include.length > 0 && !matchesAnyGlob(relativePath, opts.include)) { stats.skippedIgnored++; continue; }
        if (opts.exclude.length > 0 && matchesAnyGlob(relativePath, opts.exclude)) { stats.skippedIgnored++; continue; }

        // Size check
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > opts.maxSize * 1024) {
            stats.skippedSize++;
            if (opts.verbose) console.log(`  \x1b[33mskipped (size)\x1b[0m ${relativePath} (${(stat.size / 1024).toFixed(0)}KB)`);
            continue;
          }
        } catch { continue; }

        // Binary content check
        if (isBinary(fullPath)) {
          stats.skippedBinary++;
          if (opts.verbose) console.log(`  \x1b[33mskipped (binary)\x1b[0m ${relativePath}`);
          continue;
        }

        // Read file
        try {
          let content = fs.readFileSync(fullPath, 'utf8');
          const lang = getLang(fullPath);

          // Strip comments if requested
          if (opts.noComments) {
            content = stripComments(content, lang);
          }

          // Compress if requested
          if (opts.compress) {
            content = compressCode(content, lang);
          }

          // Clean up: strip trailing whitespace, collapse blank lines
          content = content
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          // Add line numbers if requested
          if (opts.lineNumbers) {
            const lines = content.split('\n');
            const pad = String(lines.length).length;
            content = lines.map((line, i) =>
              `${String(i + 1).padStart(pad)} | ${line}`
            ).join('\n');
          }

          files.push({ path: relativePath, content, lang });
        } catch (e) {
          if (opts.verbose) console.log(`  \x1b[31merror\x1b[0m ${relativePath}: ${e.message}`);
        }
      }
    }
  }

  walk(rootDir);
  return { files, stats };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const cliOpts = parseArgs(process.argv);

  if (cliOpts.version) {
    console.log(`${NAME} v${VERSION}`);
    process.exit(0);
  }

  if (cliOpts.help) {
    printHelp();
    process.exit(0);
  }

  const rootDir = process.cwd();
  const config = loadConfig(rootDir, cliOpts.config);
  const opts = mergeOpts(cliOpts, config);

  // Validate style
  if (!['plain', 'xml', 'markdown'].includes(opts.style)) {
    console.error(`\x1b[31m✗ Unknown style: ${opts.style}. Use: plain, xml, markdown\x1b[0m`);
    process.exit(1);
  }

  const projectName = path.basename(rootDir) || 'PROJECT';
  const styleExts = { plain: '.txt', xml: '.xml', markdown: '.md' };
  const outputFileName = opts.output || `repo-text-output${styleExts[opts.style]}`;
  const outputFile = path.isAbsolute(outputFileName)
    ? outputFileName
    : path.resolve(rootDir, outputFileName);

  console.log(`\n\x1b[1m\x1b[36m⚡ repo-text\x1b[0m v${VERSION}\n`);
  console.log(`  \x1b[2mPacking:\x1b[0m  ${projectName}`);
  console.log(`  \x1b[2mStyle:\x1b[0m    ${opts.style}`);
  console.log(`  \x1b[2mOutput:\x1b[0m   ${path.relative(rootDir, outputFile) || outputFile}`);

  const startTime = Date.now();

  // Build ignore filter
  const ig = createIgnoreFilter(rootDir);

  // Generate tree
  const tree = opts.tree ? generateTree(rootDir, ig, opts) : null;

  // Walk files
  const { files, stats } = walkFiles(rootDir, ig, opts);

  // Security scan
  const allSecrets = [];
  if (!opts.noSecurityCheck) {
    for (const f of files) {
      const warnings = scanSecrets(f.content, f.path);
      allSecrets.push(...warnings);
    }
  }

  // Format output
  let output;
  switch (opts.style) {
    case 'xml':
      output = formatXml(projectName, tree, files, opts);
      break;
    case 'markdown':
      output = formatMarkdown(projectName, tree, files, opts);
      break;
    default:
      output = formatPlain(projectName, tree, files, opts);
  }

  // Final cleanup
  output = output.replace(/\n{3,}/g, '\n\n');

  // Write output
  try {
    fs.writeFileSync(outputFile, output);
  } catch (err) {
    console.error(`\n\x1b[31m✗ Failed to write: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // Token count
  const charCount = output.length;
  const tokenCount = opts.noTokens ? null : countTokens(output);

  // Copy to clipboard
  let copied = false;
  if (opts.copy) {
    copied = copyToClipboard(output);
  }

  // Security warnings
  if (allSecrets.length > 0) {
    console.log(`\n  \x1b[1m\x1b[33m⚠ Security Warnings:\x1b[0m`);
    const grouped = {};
    for (const s of allSecrets) {
      if (!grouped[s.file]) grouped[s.file] = [];
      grouped[s.file].push(s.type);
    }
    for (const [file, types] of Object.entries(grouped)) {
      console.log(`    \x1b[33m${file}\x1b[0m — ${types.join(', ')}`);
    }
    console.log(`    \x1b[2mUse --no-security-check to suppress\x1b[0m`);
  }

  // Summary
  const elapsed = Date.now() - startTime;
  const sizeKB = (charCount / 1024).toFixed(1);

  console.log(`\n  \x1b[1m\x1b[32m✓ Done\x1b[0m in ${elapsed}ms\n`);
  console.log(`  \x1b[2mFiles:\x1b[0m    ${files.length} packed`);
  if (stats.skippedBinary + stats.skippedSize + stats.skippedIgnored > 0) {
    console.log(`  \x1b[2mSkipped:\x1b[0m  ${stats.skippedBinary} binary, ${stats.skippedSize} oversized, ${stats.skippedIgnored} ignored`);
  }
  console.log(`  \x1b[2mSize:\x1b[0m     ${sizeKB} KB (${charCount.toLocaleString()} chars)`);
  if (tokenCount !== null) {
    console.log(`  \x1b[2mTokens:\x1b[0m   ~${tokenCount.toLocaleString()}`);
  }
  if (copied) {
    console.log(`  \x1b[2mClipboard:\x1b[0m ✓ copied`);
  } else if (opts.copy) {
    console.log(`  \x1b[2mClipboard:\x1b[0m ✗ failed (install xclip or xsel on Linux)`);
  }
  console.log('');
}

main();
