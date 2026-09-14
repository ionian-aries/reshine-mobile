import { checkbox } from '@inquirer/prompts';
import { normalizeError, readBuildConfig, resolveUniappTarget, validateUniappProject } from './utils/config.js';
import { runNpm } from './utils/process.js';
import { requireInteractiveTerminal } from './utils/targets.js';

function parseTargets(args, availableNames) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--targets') throw new Error('仅支持参数 --targets <项目1,项目2>');
  const names = args[1].split(',').map((name) => name.trim());
  if (names.some((name) => name === '')) throw new Error('--targets 不能包含空项目名称');
  const uniqueNames = [...new Set(names)];
  const unknownNames = uniqueNames.filter((name) => !availableNames.includes(name));
  if (unknownNames.length) throw new Error(`未知项目：${unknownNames.join('、')}；可用项目：${availableNames.join('、')}`);
  return uniqueNames;
}

async function chooseTargets(args, availableNames) {
  const explicit = parseTargets(args, availableNames);
  if (explicit) return explicit;
  requireInteractiveTerminal('未指定 --targets 时的目标选择');
  return checkbox({ message: '请选择项目（空格选择，Enter 确认）', required: true, choices: availableNames.map((name) => ({ name, value: name })) });
}

async function main() {
  const { targets, availableNames } = await readBuildConfig();
  const selectedNames = await chooseTargets(process.argv.slice(2), availableNames);
  console.log(`[init:uniapp] 可用项目：${availableNames.join('、')}`);
  console.log(`[init:uniapp] 本次初始化 ${selectedNames.length} 个项目：${selectedNames.join('、')}`);
  const results = [];
  for (const [offset, name] of selectedNames.entries()) {
    const index = offset + 1;
    let target = { name, relativeDir: targets[name]?.uniapp?.dir ?? '未配置' };
    console.log(`\n[init:uniapp] [${index}/${selectedNames.length}] 正在初始化 ${name}`);
    try {
      target = await resolveUniappTarget(name, targets[name]);
      await validateUniappProject(target);
      await runNpm(['ci'], { cwd: target.dir, label: 'npm ci' });
      console.log(`[init:uniapp] [${index}/${selectedNames.length}] ${name} 初始化成功`);
      results.push({ ...target, success: true });
    } catch (error) {
      const normalizedError = normalizeError(error);
      console.error(`[init:uniapp] [${index}/${selectedNames.length}] ${name} 初始化失败：${normalizedError.message}`);
      results.push({ ...target, success: false, error: normalizedError });
    }
  }
  console.log('\n[init:uniapp] 初始化结果');
  for (const result of results) console.log(`  ${result.success ? '✓' : '✗'} ${result.name} (${result.relativeDir})：${result.success ? '成功' : `失败 - ${result.error.message}`}`);
  const failed = results.filter(({ success }) => !success).length;
  console.log(`\n[init:uniapp] 总计 ${results.length} 个项目：成功 ${results.length - failed} 个，失败 ${failed} 个`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(`[init:uniapp] 初始化无法开始：${normalizeError(error).message}`); process.exitCode = 1; });