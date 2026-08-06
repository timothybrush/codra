import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Pure-ish leaves of the Cloudflare setup script: process spawning, id extraction, .dev.vars
// reading and secret writing. None of them holds a handle open across calls, so importing this
// module has no side effects -- the imperative provisioning flow stays in setup-cloudflare.js.

export const WRANGLER_JSONC_PATH = path.join(process.cwd(), 'wrangler.jsonc');
export const DEV_VARS_PATH = path.join(process.cwd(), '.dev.vars');

export function spawnAsync(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? `${command}.cmd` : command, args);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      if (code === 0) resolve({ stdout });
      else {
        const err = new Error(`Command failed with code ${code}`);
        err.stderr = stderr;
        reject(err);
      }
    });
    child.on('error', err => reject(err));
  });
}

export function extractId(output) {
  const match = output.match(/[a-f0-9]{32}/);
  return match ? match[0] : null;
}

export function getEnvVars() {
  const env = {};
  if (fs.existsSync(DEV_VARS_PATH)) {
    const content = fs.readFileSync(DEV_VARS_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() && !line.startsWith('#')) {
        const [key, ...values] = line.split('=');
        if (key && values.length > 0) {
          // Strip surrounding quotes, then unescape literal \n sequences
          // (wrangler secrets must receive real newlines, not the two chars \ and n)
          const raw = values.join('=').trim().replace(/^"|"$/g, '');
          env[key.trim()] = raw.replace(/\\n/g, '\n');
        }
      }
    }
  }
  return env;
}

export function setSecret(secretName, secretValue) {
  return new Promise((resolve, reject) => {
    const child = exec(`npx wrangler secret put ${secretName}`, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
    
    child.stdin.write(secretValue);
    child.stdin.end();
  });
}
