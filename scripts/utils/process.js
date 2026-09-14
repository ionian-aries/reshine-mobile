import { spawn } from 'node:child_process';

export function runNpm(args, { cwd, label = `npm ${args.join(' ')}` } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${label} 被信号 ${signal} 终止`));
      else if (code !== 0) reject(new Error(`${label} 执行失败，退出码：${code}`));
      else resolve();
    });
  });
}
