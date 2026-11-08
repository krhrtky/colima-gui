import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { $, browser } from '@wdio/globals';

const execute = promisify(execFile);
const profile = process.env.COLIMA_GUI_E2E_PROFILE;
const artifactDir = process.env.COLIMA_GUI_E2E_ARTIFACT_DIR;
const originalContext = process.env.COLIMA_GUI_E2E_ORIGINAL_CONTEXT;
const containerName = 'colima-gui-acceptance';
const logMarker = `colima-gui-acceptance-${profile}`;
const selector = (name) => `[data-testid="${name}"]`;
const element = (name) => $(selector(name));

async function command(binary, args, timeout = 30000) {
  const environment = { ...process.env };
  if (binary === 'docker' && args.includes('--host')) {
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      delete environment[name];
    }
  }
  const { stdout } = await execute(binary, args, {
    encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: environment,
  });
  return stdout.trim();
}

async function colima(...args) {
  return command('colima', [...args, '--profile', profile]);
}

async function profileList() {
  const output = await command('colima', ['list', '--json']);
  return output ? output.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function observation(step, details) {
  await appendFile(path.join(artifactDir, 'observations.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), step, ...details,
  })}\n`);
}

async function screenshot(name) {
  try {
    await browser.saveScreenshot(path.join(artifactDir, name));
  } catch (error) {
    await observation('screenshot-error', { message: error.message });
  }
}

async function assertUnrelatedState() {
  assert.equal(await command('docker', ['context', 'show']), originalContext, '既存の Docker context を維持する');
  const baseline = JSON.parse(await readFile(path.join(artifactDir, 'baseline.json'), 'utf8'));
  const current = await profileList();
  for (const before of baseline.profiles) {
    assert.deepEqual(current.find((entry) => entry.name === before.name), before,
      `既存プロファイル ${before.name} を変更しない`);
  }
}

async function waitForOperation() {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (await element('operation-error').isDisplayed()) {
      throw new Error(await element('operation-error').getText());
    }
    if (!(await element('operation-progress').isExisting()) && await element('operation-success').isDisplayed()) return;
    await browser.pause(500);
  }
  throw new Error('Colima 操作の完了が 600 秒以内に画面へ反映されませんでした。');
}

async function assertProfileState(expected) {
  assert.equal(await element('selected-profile').getText(), profile);
  assert.equal(await element('profile-status').getText(), expected);
  const actual = (await profileList()).find((entry) => entry.name === profile);
  assert.equal(actual?.status, expected, 'CLI から独立してプロファイルの状態を確認する');
  await observation(`profile-${expected.toLowerCase()}`, { profile: actual });
  await assertUnrelatedState();
  return actual;
}

async function setResources(cpus, memory, disk) {
  await element('resource-cpus').setValue(String(cpus));
  await element('resource-memory').setValue(String(memory));
  await element('resource-disk').setValue(String(disk));
}

describe('実機 Colima の GUI 操作', () => {
  before(() => {
    assert.match(profile ?? '', /^cgui-e2e-\d+-\d+$/);
    assert.ok(artifactDir && originalContext, 'npm run test:e2e から実行する');
  });

  afterEach(async function () {
    const name = this.currentTest?.state === 'failed' ? 'failure.png' : 'completed.png';
    await screenshot(name);
  });

  it('作成・コンテナ操作・再起動・停止・資源変更・削除を実際に完了する', async () => {
    await element('new-profile').waitForDisplayed();
    await element('new-profile').click();
    await element('profile-name').setValue(profile);
    await setResources(2, 2, 10);
    await element('profile-submit').click();
    await element('operation-progress').waitForDisplayed();
    assert.equal(await element('new-profile').isEnabled(), false, '処理中は重複操作を開始できない');
    await waitForOperation();
    const created = await assertProfileState('Running');
    assert.equal(created.cpus, 2);
    assert.equal(created.memory, 2 * 1024 ** 3);
    assert.equal(created.disk, 10 * 1024 ** 3);
    await element(`profile-${profile}`).waitForDisplayed();
    await screenshot('profile-created.png');

    const beforeDuplicate = await profileList();
    await element('new-profile').click();
    await element('profile-name').setValue(profile);
    await setResources(4, 4, 20);
    await element('profile-submit').click();
    await element('operation-error').waitForDisplayed({ timeout: 30000 });
    assert.match(await element('operation-error').getText(), /既に存在/);
    await browser.waitUntil(async () => !(await element('operation-progress').isExisting()));
    assert.equal(await element('operation-success').isExisting(), false,
      '拒否された操作を成功として表示しない');
    assert.deepEqual(await profileList(), beforeDuplicate,
      '同名プロファイルの作成失敗で既存の実状態を変更しない');
    await assertProfileState('Running');
    await screenshot('duplicate-profile-error.png');
    await $('button[aria-label="エラーを閉じる"]').click();
    await element('operation-error').waitForExist({ reverse: true });
    await observation('duplicate-profile-rejected', { profile, unchanged: true });

    const status = JSON.parse(await colima('status', '--json'));
    assert.match(status.docker_socket, /^unix:\/\//);
    const docker = (...args) => command('docker', ['--host', status.docker_socket, ...args], 180000);
    assert.ok(await docker('info', '--format', '{{.ServerVersion}}'), 'Docker daemon が利用可能になる');
    const containerId = await docker('run', '--detach', '--name', containerName,
      'alpine:3.22', 'sh', '-c', `echo '${logMarker}'; exec sleep 86400`);
    assert.match(containerId, /^[a-f0-9]{64}$/);
    await observation('docker-ready', { dockerSocket: status.docker_socket, containerId });

    await element('refresh').click();
    const row = await element(`container-${containerId}`);
    await row.waitForDisplayed({ timeout: 30000 });
    assert.equal(await row.$(selector('container-state')).getText(), 'running');

    await row.$(selector('container-logs')).click();
    await element('container-log-output').waitForDisplayed();
    await browser.waitUntil(async () => (await element('container-log-output').getText()).includes(logMarker), {
      timeout: 30000, timeoutMsg: '実コンテナが出力したログを GUI に表示する',
    });
    await screenshot('container-logs.png');
    await element('close-logs').click();
    await observation('container-logs', { containerId, marker: logMarker });

    await row.$(selector('container-stop')).click();
    await waitForOperation();
    assert.equal(await docker('inspect', '--format', '{{.State.Status}}', containerId), 'exited');
    assert.equal(await row.$(selector('container-state')).getText(), 'exited');
    await observation('container-stop', { containerId, state: 'exited' });

    await row.$(selector('container-start')).click();
    await waitForOperation();
    assert.equal(await docker('inspect', '--format', '{{.State.Status}}', containerId), 'running');
    assert.equal(await row.$(selector('container-state')).getText(), 'running');
    await observation('container-start', { containerId, state: 'running' });

    const bootIdBefore = await command('colima', ['ssh', '--profile', profile, '--',
      'cat', '/proc/sys/kernel/random/boot_id']);
    await element('profile-restart').click();
    await waitForOperation();
    await assertProfileState('Running');
    const bootIdAfter = await command('colima', ['ssh', '--profile', profile, '--',
      'cat', '/proc/sys/kernel/random/boot_id']);
    assert.notEqual(bootIdBefore, bootIdAfter, 'VM が実際に再起動したことを確認する');
    assert.ok(await docker('info', '--format', '{{.ServerVersion}}'));
    await observation('profile-restart', { bootIdBefore, bootIdAfter });

    await element('profile-stop').click();
    await waitForOperation();
    await assertProfileState('Stopped');

    await element('profile-settings').click();
    await setResources(3, 3, 11);
    await element('profile-submit').click();
    await waitForOperation();
    const configured = await assertProfileState('Running');
    assert.equal(configured.cpus, 3);
    assert.equal(configured.memory, 3 * 1024 ** 3);
    assert.equal(configured.disk, 11 * 1024 ** 3);
    assert.ok(await docker('info', '--format', '{{.ServerVersion}}'));
    await observation('profile-resources', { profile: configured });
    await screenshot('profile-configured.png');

    await element('profile-stop').click();
    await waitForOperation();
    await assertProfileState('Stopped');
    await element('profile-start').click();
    await waitForOperation();
    await assertProfileState('Running');
    assert.ok(await docker('info', '--format', '{{.ServerVersion}}'));

    await element('profile-stop').click();
    await waitForOperation();
    await assertProfileState('Stopped');
    await element('profile-delete').click();
    await element('delete-confirm-name').setValue(profile);
    const deleteData = await element('delete-data');
    if (!(await deleteData.isSelected())) await deleteData.click();
    await element('delete-submit').click();
    await waitForOperation();
    assert.equal((await profileList()).some((entry) => entry.name === profile), false);
    assert.equal(await element(`profile-${profile}`).isExisting(), false);
    await assertUnrelatedState();
    await observation('profile-delete', { profile, absent: true, deleteData: true });
    await writeFile(path.join(artifactDir, 'gui-result.json'), JSON.stringify({
      passed: true,
      profile,
      checks: ['create', 'duplicate-profile-rejected', 'docker-ready', 'container-logs', 'container-stop', 'container-start',
        'profile-restart', 'profile-stop', 'profile-resources', 'profile-start', 'profile-delete',
        'unrelated-profiles-unchanged', 'docker-context-unchanged'],
    }, null, 2));
  });
});
