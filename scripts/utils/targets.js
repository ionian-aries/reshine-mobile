import { select } from '@inquirer/prompts';

function validateTarget(name, availableNames) {
  if (!availableNames.includes(name)) throw new Error(`未知项目：${name}；可用项目：${availableNames.join('、')}`);
  return name;
}

export function parseSingleTarget(args, availableNames) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--target' || args[1].trim() === '') throw new Error('仅支持参数 --target <项目>');
  return validateTarget(args[1].trim(), availableNames);
}

export function requireInteractiveTerminal(message = '该操作') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${message}需要在交互式终端中执行`);
}

export async function chooseSingleTarget(args, availableNames) {
  const explicit = parseSingleTarget(args, availableNames);
  if (explicit) return explicit;
  requireInteractiveTerminal('未指定 --target 时的目标选择');
  return select({ message: '请选择项目', choices: availableNames.map((name) => ({ name, value: name })) });
}