import { spawn } from 'node:child_process';

export function runCommand(command, args, { cwd, env, label = `${command} ${args.join(' ')}` } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: 'inherit' });
    child.once('error', (error) => reject(new Error(`${label} 无法启动：${error.message}`)));
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${label} 被信号 ${signal} 终止`));
      else if (code !== 0) reject(new Error(`${label} 执行失败，退出码：${code}`));
      else resolve();
    });
  });
}

export function runNpm(args, { cwd, env, label = `npm ${args.join(' ')}` } = {}) {
  return runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, env, label });
}
