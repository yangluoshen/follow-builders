import { spawn } from 'child_process';

export function runUniver(args, options = {}) {
  const univerPath = options.univerPath || process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer';
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const command = ['univer', ...args].join(' ');
  const attemptedCommand = [univerPath, ...args].join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn(univerPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', err => {
      reject(new Error(`Could not run univer ${attemptedCommand}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf-8');
      const err = Buffer.concat(stderr).toString('utf-8');
      if (signal) {
        reject(new Error(`${command} failed with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} failed with exit code ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

export async function runUniverJson(args, options = {}) {
  const result = await runUniver([...args, '--json'], options);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Could not parse univer JSON output for ${args.join(' ')}: ${err.message}`);
  }
}
