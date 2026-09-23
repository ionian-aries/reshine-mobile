function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export function createStageTimer(scope, { now = () => Date.now(), log = console.log } = {}) {
  const startedAt = now();
  let active = null;

  async function stage(name, operation) {
    const stageStartedAt = now();
    active = { name, startedAt: stageStartedAt };
    log(`[${scope}] 阶段开始：${name}`);
    try {
      const result = await operation();
      log(`[${scope}] 阶段完成：${name}（${formatDuration(now() - stageStartedAt)}）`);
      return result;
    } catch (error) {
      log(`[${scope}] 阶段失败：${name}（${formatDuration(now() - stageStartedAt)}）`);
      throw error;
    } finally {
      active = null;
    }
  }

  function finish(succeeded) {
    if (active) log(`[${scope}] 中断阶段：${active.name}（${formatDuration(now() - active.startedAt)}）`);
    log(`[${scope}] 总耗时：${formatDuration(now() - startedAt)}（${succeeded ? '成功' : '失败'}）`);
  }

  return { stage, finish };
}

export { formatDuration };