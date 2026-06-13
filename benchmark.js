#!/usr/bin/env node

/**
 * Benchmark: repo-text vs repomix
 *
 * Run: node benchmark.js [target-directory]
 *
 * Compares execution time, output size, and token counts
 * between repo-text and repomix on the same codebase.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2] || process.cwd();
const absTarget = path.resolve(targetDir);

console.log('\n\x1b[1m\x1b[36m⚡ repo-text Benchmark\x1b[0m\n');
console.log(`  Target: ${absTarget}\n`);

// Check if repomix is available
let hasRepomix = false;
try {
  execSync('npx repomix --version', { stdio: 'pipe', cwd: absTarget, timeout: 30000 });
  hasRepomix = true;
} catch {
  console.log('  \x1b[33m⚠ repomix not found. Install with: npm i -g repomix\x1b[0m');
  console.log('  \x1b[2mRunning repo-text benchmarks only.\x1b[0m\n');
}

const results = {};

// ── repo-text benchmarks ──────────────────────────────────────────────────────
const repoTextBin = path.join(__dirname, 'bin', 'flatter.js');

const styles = ['plain', 'xml', 'markdown'];
const variants = [
  { name: 'plain', flags: '--style plain' },
  { name: 'xml', flags: '--style xml' },
  { name: 'markdown', flags: '--style markdown' },
  { name: 'xml + tree', flags: '--style xml --tree' },
  { name: 'xml + compress', flags: '--style xml --compress' },
  { name: 'xml + tree + compress', flags: '--style xml --tree --compress' },
  { name: 'plain + line-numbers', flags: '--style plain --line-numbers' },
  { name: 'xml + no-comments', flags: '--style xml --no-comments' },
];

console.log('  \x1b[1m── repo-text ──\x1b[0m\n');

for (const v of variants) {
  const outFile = path.join(absTarget, `_benchmark_rt_${v.name.replace(/[^a-z]/g, '_')}.out`);
  const cmd = `node "${repoTextBin}" ${v.flags} -o "${outFile}" --no-security-check`;

  try {
    const start = process.hrtime.bigint();
    execSync(cmd, { cwd: absTarget, stdio: 'pipe', timeout: 60000 });
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;

    const stat = fs.statSync(outFile);
    const sizeKB = (stat.size / 1024).toFixed(1);

    results[`rt_${v.name}`] = { ms: ms.toFixed(0), sizeKB, bytes: stat.size };

    console.log(`  \x1b[32m✓\x1b[0m ${v.name.padEnd(28)} ${String(ms.toFixed(0)).padStart(6)}ms  ${sizeKB.padStart(8)} KB`);

    // Clean up
    fs.unlinkSync(outFile);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${v.name.padEnd(28)} FAILED: ${e.message.split('\n')[0]}`);
  }
}

// ── repomix benchmarks ────────────────────────────────────────────────────────
if (hasRepomix) {
  console.log('\n  \x1b[1m── repomix ──\x1b[0m\n');

  const repomixVariants = [
    { name: 'plain', flags: '--style plain' },
    { name: 'xml', flags: '--style xml' },
    { name: 'markdown', flags: '--style markdown' },
    { name: 'xml + compress', flags: '--style xml --compress' },
  ];

  for (const v of repomixVariants) {
    const outFile = path.join(absTarget, `_benchmark_rm_${v.name.replace(/[^a-z]/g, '_')}.out`);
    const cmd = `npx repomix ${v.flags} -o "${outFile}"`;

    try {
      const start = process.hrtime.bigint();
      execSync(cmd, { cwd: absTarget, stdio: 'pipe', timeout: 120000 });
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1_000_000;

      const stat = fs.statSync(outFile);
      const sizeKB = (stat.size / 1024).toFixed(1);

      results[`rm_${v.name}`] = { ms: ms.toFixed(0), sizeKB, bytes: stat.size };

      console.log(`  \x1b[32m✓\x1b[0m ${v.name.padEnd(28)} ${String(ms.toFixed(0)).padStart(6)}ms  ${sizeKB.padStart(8)} KB`);

      // Clean up
      fs.unlinkSync(outFile);
    } catch (e) {
      console.log(`  \x1b[31m✗\x1b[0m ${v.name.padEnd(28)} FAILED: ${e.message.split('\n')[0]}`);
    }
  }
}

// ── Comparison table ──────────────────────────────────────────────────────────
if (hasRepomix) {
  console.log('\n  \x1b[1m── Comparison ──\x1b[0m\n');
  console.log('  ' + ''.padEnd(20) + 'repo-text'.padStart(14) + 'repomix'.padStart(14) + 'speedup'.padStart(12));
  console.log('  ' + '─'.repeat(60));

  for (const style of ['plain', 'xml', 'markdown']) {
    const rt = results[`rt_${style}`];
    const rm = results[`rm_${style}`];
    if (rt && rm) {
      const speedup = (parseFloat(rm.ms) / parseFloat(rt.ms)).toFixed(1);
      console.log(
        `  ${style.padEnd(20)}` +
        `${rt.ms}ms`.padStart(14) +
        `${rm.ms}ms`.padStart(14) +
        `\x1b[32m${speedup}x\x1b[0m`.padStart(20)
      );
    }
  }

  // Compression comparison
  const rtc = results['rt_xml + compress'];
  const rmc = results['rm_xml + compress'];
  if (rtc && rmc) {
    const speedup = (parseFloat(rmc.ms) / parseFloat(rtc.ms)).toFixed(1);
    console.log(
      `  ${'xml+compress'.padEnd(20)}` +
      `${rtc.ms}ms`.padStart(14) +
      `${rmc.ms}ms`.padStart(14) +
      `\x1b[32m${speedup}x\x1b[0m`.padStart(20)
    );
  }
}

// ── Package size comparison ───────────────────────────────────────────────────
console.log('\n  \x1b[1m── Package Size ──\x1b[0m\n');

try {
  const rtPkg = execSync('npm pack --dry-run 2>&1 | grep "unpacked size"', {
    cwd: path.join(__dirname),
    encoding: 'utf8'
  }).trim();
  console.log(`  repo-text:  ${rtPkg}`);
} catch {
  console.log('  repo-text:  (run from repo-text directory to measure)');
}

if (hasRepomix) {
  try {
    const rmSize = execSync('npm view repomix dist.unpackedSize 2>/dev/null', { encoding: 'utf8' }).trim();
    console.log(`  repomix:    unpacked size: ${(parseInt(rmSize) / 1024).toFixed(1)} KB`);
  } catch {}
}

// Dependencies count
console.log('\n  \x1b[1m── Dependencies ──\x1b[0m\n');
try {
  const rtPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const rtDeps = Object.keys(rtPkg.dependencies || {}).length;
  console.log(`  repo-text:  ${rtDeps} dependencies`);
} catch {}

if (hasRepomix) {
  try {
    const rmDeps = execSync('npm view repomix dependencies --json 2>/dev/null', { encoding: 'utf8' });
    const count = Object.keys(JSON.parse(rmDeps)).length;
    console.log(`  repomix:    ${count} dependencies`);
  } catch {}
}

console.log('');
