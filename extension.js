const vscode = require('vscode');

const TICK_INTERVAL_MS = 200;
const DAY_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_REPETITIONS_PER_SET = 20;
const DEFAULT_PHASE_DURATION_SECONDS = 4;
const STATS_KEY = 'tigang-helper.dailyStats';
const STATUS_BAR_EMOJI = '🧘';

/**
 * @typedef {Object} DailyStats
 * @property {string} date 本地日期，格式为 YYYY-MM-DD
 * @property {number} contractions 已完成的收紧次数
 * @property {number} sets 已完成的组数
 * @property {number} contractionsInCurrentSet 当前未完成组中的次数
 */

/**
 * @param {Date} [date]
 * @returns {string}
 */
function getDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * @returns {DailyStats}
 */
function createEmptyStats() {
  return {
    date: getDateKey(),
    contractions: 0,
    sets: 0,
    contractionsInCurrentSet: 0
  };
}

/**
 * @param {unknown} value
 * @returns {DailyStats}
 */
function normalizeStats(value) {
  if (!value || typeof value !== 'object') {
    return createEmptyStats();
  }

  const stored = /** @type {Partial<DailyStats>} */ (value);
  const stats = createEmptyStats();
  stats.date = typeof stored.date === 'string' ? stored.date : stats.date;
  stats.contractions = Number.isFinite(stored.contractions)
    ? Math.max(0, Math.floor(stored.contractions))
    : 0;
  stats.sets = Number.isFinite(stored.sets)
    ? Math.max(0, Math.floor(stored.sets))
    : 0;
  stats.contractionsInCurrentSet = Number.isFinite(stored.contractionsInCurrentSet)
    ? Math.max(0, Math.floor(stored.contractionsInCurrentSet))
    : 0;
  return stats;
}

/**
 * @returns {number}
 */
function getRepetitionsPerSet() {
  const configured = vscode.workspace
    .getConfiguration('tigangHelper')
    .get('repetitionsPerSet', DEFAULT_REPETITIONS_PER_SET);

  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_REPETITIONS_PER_SET;
  }

  return Math.max(1, Math.min(1000, Math.floor(configured)));
}

/**
 * @returns {number}
 */
function getPhaseDurationSeconds() {
  const configured = vscode.workspace
    .getConfiguration('tigangHelper')
    .get('phaseDurationSeconds', DEFAULT_PHASE_DURATION_SECONDS);

  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_PHASE_DURATION_SECONDS;
  }

  return Math.max(1, Math.min(60, Math.floor(configured)));
}

/**
 * @returns {number}
 */
function getPhaseDurationMs() {
  return getPhaseDurationSeconds() * 1000;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<DailyStats>}
 */
async function loadTodayStats(context) {
  const stats = normalizeStats(context.globalState.get(STATS_KEY));
  if (stats.date !== getDateKey()) {
    const freshStats = createEmptyStats();
    await context.globalState.update(STATS_KEY, freshStats);
    return freshStats;
  }

  return stats;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {DailyStats} stats
 * @returns {Promise<void>}
 */
async function saveStats(context, stats) {
  await context.globalState.update(STATS_KEY, stats);
}

/**
 * @param {vscode.StatusBarItem} statusBarItem
 * @param {DailyStats} stats
 * @param {{ running: boolean, phase: 'tighten' | 'relax', phaseDeadline: number }} exercise
 */
function renderStatus(statusBarItem, stats, exercise) {
  const countText = `${stats.contractions}次 · ${stats.sets}组`;
  const phaseDurationSeconds = getPhaseDurationSeconds();
  statusBarItem.text = STATUS_BAR_EMOJI;

  if (!exercise.running) {
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**练习计时**\n\n` +
      `点击开始一组练习\n\n` +
      `今日：${stats.contractions} 次 · ${stats.sets} 组\n\n` +
      `每 ${getRepetitionsPerSet()} 次收紧计为 1 组\n\n` +
      `收紧和放松各 ${phaseDurationSeconds} 秒\n\n` +
      `完成一组后自动停止`
    );
    return;
  }

  const secondsRemaining = Math.max(
    1,
    Math.ceil((exercise.phaseDeadline - Date.now()) / 1000)
  );
  const phaseLabel = exercise.phase === 'tighten' ? '收紧' : '放松';
  statusBarItem.text = `${STATUS_BAR_EMOJI} ${phaseLabel} ${secondsRemaining}s | ${countText}`;
  statusBarItem.tooltip = new vscode.MarkdownString(
    `**练习进行中**\n\n` +
    `当前：${phaseLabel}，剩余约 ${secondsRemaining} 秒\n\n` +
    `今日：${stats.contractions} 次 · ${stats.sets} 组\n\n` +
    `节奏：收紧 ${phaseDurationSeconds} 秒 → 放松 ${phaseDurationSeconds} 秒\n\n` +
    `每 ${getRepetitionsPerSet()} 次收紧计为 1 组\n\n` +
    `完成一组后自动停止，点击可提前停止`
  );
}

/**
 * VS Code extension entry point.
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'tigang-helper.toggle';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  let stats = await loadTodayStats(context);
  const exercise = {
    running: false,
    phase: 'tighten',
    phaseDeadline: 0
  };
  let tickInProgress = false;
  let exerciseTimer = null;

  const updateStatus = () => renderStatus(statusBarItem, stats, exercise);
  updateStatus();

  const ensureToday = async () => {
    const today = getDateKey();
    if (stats.date === today) {
      return;
    }

    stats = createEmptyStats();
    await saveStats(context, stats);
    updateStatus();
  };

  const stopExerciseTimer = () => {
    if (exerciseTimer !== null) {
      clearInterval(exerciseTimer);
      exerciseTimer = null;
    }
  };

  /**
   * @returns {Promise<boolean>} 是否刚好完成了一组
   */
  const recordCompletedContraction = async () => {
    stats.contractions += 1;
    stats.contractionsInCurrentSet += 1;

    let completedSet = false;
    if (stats.contractionsInCurrentSet >= getRepetitionsPerSet()) {
      stats.sets += 1;
      stats.contractionsInCurrentSet = 0;
      completedSet = true;
    }

    await saveStats(context, stats);
    return completedSet;
  };

  const tick = async () => {
    if (!exercise.running || tickInProgress) {
      return;
    }

    tickInProgress = true;
    try {
      await ensureToday();
      const now = Date.now();

      // while 可以补齐 VS Code 恢复、系统休眠等造成的计时器延迟。
      while (exercise.running && now >= exercise.phaseDeadline) {
        if (exercise.phase === 'tighten') {
          const completedSet = await recordCompletedContraction();
          if (completedSet) {
            exercise.running = false;
            exercise.phase = 'tighten';
            exercise.phaseDeadline = 0;
            stopExerciseTimer();
            break;
          }
          exercise.phase = 'relax';
        } else {
          exercise.phase = 'tighten';
        }
        exercise.phaseDeadline += getPhaseDurationMs();
      }

      updateStatus();
    } finally {
      tickInProgress = false;
    }
  };

  const startExercise = async () => {
    await ensureToday();
    exercise.running = true;
    exercise.phase = 'tighten';
    exercise.phaseDeadline = Date.now() + getPhaseDurationMs();
    stopExerciseTimer();
    exerciseTimer = setInterval(() => {
      void tick().catch((error) => {
        console.error('提肛小助手计时失败', error);
      });
    }, TICK_INTERVAL_MS);
    updateStatus();
  };

  const stopExercise = () => {
    stopExerciseTimer();
    exercise.running = false;
    exercise.phase = 'tighten';
    exercise.phaseDeadline = 0;
    updateStatus();
  };

  const toggleExercise = async () => {
    if (exercise.running) {
      stopExercise();
    } else {
      await startExercise();
    }
  };

  const resetToday = async () => {
    stats = createEmptyStats();
    await saveStats(context, stats);
    updateStatus();
    vscode.window.showInformationMessage('今日练习统计已清零。');
  };

  const dayCheckTimer = setInterval(() => {
    void ensureToday().catch((error) => {
      console.error('提肛小助手日期检查失败', error);
    });
  }, DAY_CHECK_INTERVAL_MS);

  context.subscriptions.push(
    vscode.commands.registerCommand('tigang-helper.toggle', () => {
      return toggleExercise();
    }),
    vscode.commands.registerCommand('tigang-helper.resetToday', () => {
      return resetToday();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('tigangHelper.repetitionsPerSet') ||
        event.affectsConfiguration('tigangHelper.phaseDurationSeconds')
      ) {
        updateStatus();
      }
    }),
    { dispose: stopExerciseTimer },
    { dispose: () => clearInterval(dayCheckTimer) }
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  getDateKey,
  createEmptyStats,
  normalizeStats
};
