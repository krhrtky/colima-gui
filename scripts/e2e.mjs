import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = `cgui-e2e-${Date.now()}-${process.pid}`;
const artifactDir = path.join(root, 'tmp', 'e2e', profile);
const environment = {
  ...process.env,
  VITE_E2E: 'true',
  COLIMA_GUI_E2E_PROFILE: profile,
  COLIMA_GUI_E2E_ARTIFACT_DIR: artifactDir,
};
let activeChild;
let interruptedSignal;

function interrupt(signal) {
  interruptedSignal ??= signal;
  if (!activeChild?.pid) return;
  try {
    if (process.platform === 'win32') activeChild.kill(signal);
    else process.kill(-activeChild.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
const interruptOnSigint = () => interrupt('SIGINT');
const interruptOnSigterm = () => interrupt('SIGTERM');

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function profiles() {
  const output = command('colima', ['list', '--json']);
  return output ? output.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    if (interruptedSignal) {
      reject(new Error(`E2E interrupted by ${interruptedSignal}`));
      return;
    }
    const child = spawn(binary, args, {
      cwd: root, env: environment, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    activeChild = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      activeChild = undefined;
      if (code === 0 && !interruptedSignal) resolve();
      else reject(new Error(`${binary} exited with ${signal ?? code}`));
    });
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  if (!/^cgui-e2e-\d+-\d+$/.test(profile) || profile.length > 40) {
    throw new Error('テスト専用プロファイル名が不正です。');
  }
  const colimaVersion = command('colima', ['version']);
  const dockerVersion = command('docker', ['--version']);
  const baseline = profiles();
  if (baseline.some((entry) => entry.name === profile)) {
    throw new Error(`既存プロファイル ${profile} はテストに利用できません。`);
  }
  const originalContext = command('docker', ['context', 'show']);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'baseline.json'), JSON.stringify({
    profile,
    originalContext,
    profiles: baseline,
    colimaVersion,
    dockerVersion,
  }, null, 2));
  environment.COLIMA_GUI_E2E_ORIGINAL_CONTEXT = originalContext;
  console.log(`E2E profile: ${profile}\nArtifacts: ${artifactDir}`);

  let testError;
  const cleanupErrors = [];
  const cleanup = { profile, remainingProfile: null, currentContext: null, errors: cleanupErrors };
  process.on('SIGINT', interruptOnSigint);
  process.on('SIGTERM', interruptOnSigterm);
  try {
    if (!process.argv.includes('--skip-build')) {
      await run('npx', [
        'tauri', 'build', '--debug', '--no-bundle', '--features', 'e2e',
        '--config', 'src-tauri/tauri.e2e.conf.json',
      ]);
    }
    await run('npx', ['wdio', 'run', 'wdio.conf.mjs']);
  } catch (error) {
    testError = error;
  } finally {
    try {
      if (profiles().some((entry) => entry.name === profile)) {
        command('colima', ['delete', '--profile', profile, '--force', '--data'], { timeout: 240000 });
      }
      const finalProfiles = profiles();
      cleanup.remainingProfile = finalProfiles.find((entry) => entry.name === profile) ?? null;
      if (cleanup.remainingProfile) cleanupErrors.push('テスト専用プロファイルが削除されていません。');
      for (const before of baseline) {
        if (JSON.stringify(finalProfiles.find((entry) => entry.name === before.name)) !== JSON.stringify(before)) {
          cleanupErrors.push(`既存プロファイル ${before.name} の状態が変わりました。`);
        }
      }
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    try {
      if (command('docker', ['context', 'show']) !== originalContext) {
        cleanupErrors.push('テスト中に既存の Docker context が変更されました。');
        command('docker', ['context', 'use', originalContext]);
      }
      cleanup.currentContext = command('docker', ['context', 'show']);
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    process.removeListener('SIGINT', interruptOnSigint);
    process.removeListener('SIGTERM', interruptOnSigterm);
    await writeFile(path.join(artifactDir, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
  }
  const guiResult = await readFile(path.join(artifactDir, 'gui-result.json'), 'utf8')
    .then((contents) => JSON.parse(contents)).catch(() => null);
  const result = {
    ...guiResult,
    passed: !testError && cleanupErrors.length === 0 && guiResult?.passed === true,
    profile, startedAt, completedAt: new Date().toISOString(),
    error: testError?.message ?? null,
    cleanup,
  };
  await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  if (testError) throw testError;
  if (cleanupErrors.length) throw new Error(`E2E cleanup failed: ${cleanupErrors.join('\n')}`);
  if (!result.passed) throw new Error('GUI 受け入れテストの完了記録がありません。');
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
