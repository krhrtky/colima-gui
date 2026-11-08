import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const binary = path.join(root, 'src-tauri', 'target', 'debug', 'colima-gui');

export const config = {
  runner: 'local',
  specs: ['./e2e/**/*.spec.mjs'],
  maxInstances: 1,
  services: [['@wdio/tauri-service', {
    appBinaryPath: binary,
    driverProvider: 'embedded',
    startTimeout: 90000,
    captureBackendLogs: true,
    captureFrontendLogs: true,
  }]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application: binary },
  }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  outputDir: process.env.COLIMA_GUI_E2E_ARTIFACT_DIR,
  waitforTimeout: 15000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 1,
  mochaOpts: { ui: 'bdd', timeout: 1200000 },
};
