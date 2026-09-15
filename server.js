const http = require("http");
const crypto = require("crypto");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const DEFAULT_PORT = Number(process.env.PORT || 3021);
const DEFAULT_DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  acousticCheckups: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /clocks/:id/acoustic-checkups",
  "GET /clocks/:id/acoustic-checkups",
  "GET /clocks/:id/acoustic-checkups/latest",
  "GET /acoustic-checkups",
  "GET /acoustic-checkups/:id",
  "POST /acoustic-checkups/:id/reviews"
];

/* ---------------- 持久化：写互斥 + 原子写，保证并发只冻结一份结论 ---------------- */

function createStore(dbFile, seed) {
  let chain = Promise.resolve();
  let ready = null;

  async function ensureDb() {
    await mkdir(path.dirname(dbFile), { recursive: true });
    try {
      JSON.parse(await readFile(dbFile, "utf8"));
    } catch {
      await atomicWrite(JSON.stringify(seed, null, 2));
    }
  }

  async function atomicWrite(json) {
    const tmp = `${dbFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, dbFile);
  }

  function normalize(db) {
    return {
      clocks: db.clocks || [],
      adjustments: db.adjustments || [],
      retests: db.retests || [],
      acousticCheckups: db.acousticCheckups || []
    };
  }

  async function readRaw() {
    if (!ready) ready = ensureDb();
    await ready;
    return normalize(JSON.parse(await readFile(dbFile, "utf8")));
  }

  // 读-改-写在同一把队列锁里串行化，杜绝并发体检互相覆盖。
  function mutate(fn) {
    const run = chain.then(async () => {
      const db = await readRaw();
      const result = await fn(db);
      await atomicWrite(JSON.stringify(db, null, 2));
      return result;
    });
    // 无论成败都释放锁位，但把结果/错误继续传给等待者。
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return { read: readRaw, mutate };
}

/* ---------------- 声学分析 ---------------- */

const MIN_VALID_SAMPLES = 20;

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// 接受 "18000vph"、"28800"、"4Hz"、"3hz" 等写法。
function parseFrequency(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 100 ? value : value * 3600;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const num = Number(text.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  if (text.includes("hz")) return num * 3600;
  return num; // 默认按 vph 计
}

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function mean(nums) {
  return nums.reduce((sum, x) => sum + x, 0) / nums.length;
}

function stdDev(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(nums.reduce((sum, x) => sum + (x - m) ** 2, 0) / (nums.length - 1));
}

// 返回 { error, status }：结构问题 400；有效样本不足 422；否则 null。
function validateSamples(tickIntervalsMs, amplitudesDeg) {
  if (!Array.isArray(tickIntervalsMs) || !Array.isArray(amplitudesDeg)) {
    return { error: "tickIntervalsMs 与 amplitudesDeg 必须是等长数组", status: 400 };
  }
  if (tickIntervalsMs.length === 0) {
    return { error: "采样序列不能为空", status: 400 };
  }
  if (tickIntervalsMs.length !== amplitudesDeg.length) {
    return { error: "滴答间隔与摆幅序列长度必须一致", status: 400 };
  }
  for (const value of tickIntervalsMs) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return { error: "滴答间隔必须是正数（毫秒）", status: 400 };
    }
  }
  for (const value of amplitudesDeg) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { error: "摆幅必须是非负数（度）", status: 400 };
    }
  }
  if (tickIntervalsMs.length < MIN_VALID_SAMPLES) {
    return { error: `有效样本少于${MIN_VALID_SAMPLES}，拒绝体检且不写记录`, status: 422 };
  }
  return null;
}

// 以滴答间隔中位数的 MAD 做稳健离群剔除；MAD 为 0（走时极均匀）时
// 退化为「与期望周期偏差超过 5%」判据，避免把正常滴答误判成离群。
function removeOutliers(intervals, amplitudes, expectedMs) {
  const sorted = intervals.slice().sort((a, b) => a - b);
  const med = median(sorted);
  const deviations = intervals.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  const threshold = mad > 0 ? 3.5 * mad : expectedMs * 0.05;

  const kept = [];
  const keptIntervals = [];
  const keptAmplitudes = [];
  for (let i = 0; i < intervals.length; i++) {
    if (Math.abs(intervals[i] - med) <= threshold) {
      kept.push(i);
      keptIntervals.push(intervals[i]);
      keptAmplitudes.push(amplitudes[i]);
    }
  }
  return {
    kept,
    intervals: keptIntervals,
    amplitudes: keptAmplitudes,
    removed: intervals.length - keptIntervals.length
  };
}

function classify(metrics) {
  // 异常：日差过大、噪声过高，或摆幅不足/明显衰退
  if (
    Math.abs(metrics.dailyRateSeconds) > 60 ||
    metrics.noiseRatioPercent > 2 ||
    metrics.avgAmplitudeDeg < 200 ||
    metrics.amplitudeDropDeg >= 30
  ) {
    return { status: "abnormal", label: "异常" };
  }
  // 关注：日差偏大、噪声偏大、摆幅偏低或摆幅不稳
  if (
    Math.abs(metrics.dailyRateSeconds) > 20 ||
    metrics.noiseRatioPercent > 1 ||
    metrics.avgAmplitudeDeg < 220 ||
    metrics.amplitudeStdDevDeg > 20
  ) {
    return { status: "attention", label: "关注" };
  }
  return { status: "healthy", label: "健康" };
}

// 纯分析：输入频率 + 有序序列，输出指标与分级；样本不足时抛出 422。
function analyzeAcoustic({ vph, tickIntervalsMs, amplitudesDeg }) {
  const invalid = validateSamples(tickIntervalsMs, amplitudesDeg);
  if (invalid) {
    const error = new Error(invalid.error);
    error.status = invalid.status;
    throw error;
  }

  const expectedMs = 3600000 / vph;
  const cleaned = removeOutliers(tickIntervalsMs, amplitudesDeg, expectedMs);

  if (cleaned.intervals.length < MIN_VALID_SAMPLES) {
    const error = new Error(
      `剔除${cleaned.removed}个离群点后有效样本仅${cleaned.intervals.length}个，少于${MIN_VALID_SAMPLES}，拒绝体检且不写记录`
    );
    error.status = 422;
    throw error;
  }

  const avgIntervalMs = mean(cleaned.intervals);
  const intervalNoiseMs = stdDev(cleaned.intervals);
  const noiseRatioPercent = (intervalNoiseMs / expectedMs) * 100;
  const metrics = {
    expectedIntervalMs: round3(expectedMs),
    avgIntervalMs: round3(avgIntervalMs),
    beatErrorMs: round3(avgIntervalMs - expectedMs), // 节拍偏差：实测周期 − 期望周期
    dailyRateSeconds: round3(((avgIntervalMs - expectedMs) / expectedMs) * 86400),
    intervalNoiseMs: round3(intervalNoiseMs), // 噪声：滴答间隔标准差
    noiseRatioPercent: round3(noiseRatioPercent),
    stabilityPercent: round3(Math.max(0, 100 - noiseRatioPercent)), // 稳定度：100 − 噪声占比
    avgAmplitudeDeg: round3(mean(cleaned.amplitudes)),
    amplitudeStdDevDeg: round3(stdDev(cleaned.amplitudes)),
    amplitudeDropDeg: round3(cleaned.amplitudes[0] - cleaned.amplitudes[cleaned.amplitudes.length - 1])
  };

  const verdict = classify(metrics);
  return {
    metrics,
    status: verdict.status,
    statusLabel: verdict.label,
    cleanedSampleCount: cleaned.intervals.length,
    outlierCount: cleaned.removed,
    outlierIndexes: tickIntervalsMs
      .map((_, i) => i)
      .filter((i) => !cleaned.kept.includes(i))
  };
}

/* ---------------- HTTP 辅助 ---------------- */

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function latestAcousticCheckup(db, clockId) {
  return db.acousticCheckups
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const acousticCheckup = latestAcousticCheckup(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    latestAcousticCheckup: acousticCheckup
      ? {
          id: acousticCheckup.id,
          status: acousticCheckup.status,
          statusLabel: acousticCheckup.statusLabel,
          metrics: acousticCheckup.metrics,
          createdAt: acousticCheckup.createdAt
        }
      : null,
    qualified: retest ? retest.qualified : false
  };
}

function fingerprintPayload(clockId, vph, tickIntervalsMs, amplitudesDeg) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({ clockId, vph, tickIntervalsMs, amplitudesDeg }));
  return hash.digest("hex");
}

/* ---------------- 应用工厂（dbFile 可注入，便于测试与重启持久化） ---------------- */

function createApp(dbFile = DEFAULT_DB_FILE, hooks = {}) {
  // hooks.beforeCheckupCommit：可选的提交前异步钩子（默认空操作），仅测试用于稳定并发重叠窗口。
  const beforeCheckupCommit = hooks.beforeCheckupCommit || (async () => {});
  const store = createStore(dbFile, initialData);
  // 指纹 -> 进行中/已完成的首份体检 Promise（同一采样重复提交只返回首份）。
  const inFlight = new Map();
  // clockId -> 当前占用的指纹：同一机芯并发体检只允许冻结一份结论。
  const busyClock = new Map();

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const db = await store.read();

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
    }

    if (req.method === "GET" && pathname === "/clocks") {
      const qualified = url.searchParams.get("qualified");
      let data = db.clocks.map((clock) => clockSummary(db, clock));
      if (qualified !== null) {
        const expected = qualified === "true";
        data = data.filter((clock) => clock.qualified === expected);
      }
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/clocks") {
      const body = await parseBody(req);
      required(body, ["code", "escapementType", "balanceFrequency"]);
      const clock = await store.mutate((draft) => {
        const item = {
          id: makeId("clock"),
          code: body.code,
          escapementType: body.escapementType,
          balanceFrequency: body.balanceFrequency,
          targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
          note: body.note || "",
          createdAt: new Date().toISOString()
        };
        draft.clocks.push(item);
        return item;
      });
      const fresh = await store.read();
      return send(res, 201, { data: clockSummary(fresh, clock) });
    }

    if (req.method === "GET" && pathname === "/clocks/not-qualified") {
      const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
      return send(res, 200, { data });
    }

    const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const clock = findClock(db, historyMatch[1]);
      const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
      const retests = db.retests.filter((item) => item.clockId === clock.id);
      const acousticCheckups = db.acousticCheckups.filter((item) => item.clockId === clock.id);
      return send(res, 200, {
        data: {
          clock,
          adjustments,
          retests,
          acousticCheckups,
          latestRetest: latestRetest(db, clock.id),
          latestAcousticCheckup: latestAcousticCheckup(db, clock.id)
        }
      });
    }

    const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
    if (adjustmentMatch && req.method === "POST") {
      const clock = findClock(db, adjustmentMatch[1]);
      const body = await parseBody(req);
      required(body, ["currentDailyRateSeconds", "direction", "amount"]);
      const adjustment = await store.mutate((draft) => {
        const item = {
          id: makeId("adjustment"),
          clockId: clock.id,
          currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
          direction: body.direction,
          amount: body.amount,
          note: body.note || "",
          createdAt: new Date().toISOString()
        };
        draft.adjustments.push(item);
        return item;
      });
      return send(res, 201, { data: adjustment });
    }

    const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
    if (retestMatch && req.method === "POST") {
      const clock = findClock(db, retestMatch[1]);
      const body = await parseBody(req);
      required(body, ["dailyRateSeconds", "amplitude"]);
      const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = await store.mutate((draft) => {
        const item = {
          id: makeId("retest"),
          clockId: clock.id,
          adjustmentId,
          testedAt: body.testedAt || new Date().toISOString(),
          dailyRateSeconds: Number(body.dailyRateSeconds),
          amplitude: Number(body.amplitude),
          qualified,
          note: body.note || ""
        };
        draft.retests.push(item);
        return item;
      });
      const fresh = await store.read();
      const freshClock = fresh.clocks.find((item) => item.id === clock.id);
      return send(res, 201, { data: retest, clock: clockSummary(fresh, freshClock) });
    }

    const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
    if (latestMatch && req.method === "GET") {
      findClock(db, latestMatch[1]);
      return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
    }

    /* ---- 擒纵声学体检 ---- */

    const checkupsMatch = pathname.match(/^\/clocks\/([^/]+)\/acoustic-checkups$/);
    if (checkupsMatch && req.method === "POST") {
      const clock = findClock(db, checkupsMatch[1]);
      const body = await parseBody(req);
      required(body, ["tickIntervalsMs", "amplitudesDeg"]);
      const vph = parseFrequency(body.balanceFrequency ?? clock.balanceFrequency);
      if (!vph) {
        const error = new Error("无法识别机芯频率，请提供形如 28800vph 或 4Hz 的 balanceFrequency");
        error.status = 400;
        throw error;
      }

      const intervals = body.tickIntervalsMs;
      const amplitudes = body.amplitudesDeg;
      // 分析在写库/占并发槽之前完成：样本不足直接 422，绝不产生记录。
      const result = analyzeAcoustic({ vph, tickIntervalsMs: intervals, amplitudesDeg: amplitudes });
      const fingerprint = fingerprintPayload(clock.id, vph, intervals, amplitudes);

      // 同一采样正在进行：等它完成并返回首份结论（重复提交一律 200 去重）。
      const sameJob = inFlight.get(fingerprint);
      if (sameJob) {
        const dup = await sameJob;
        return send(res, 200, { data: dup.checkup, duplicated: true, fingerprint });
      }
      // 不同采样并发体检同一机芯：只冻结第一份，第二份拒绝且不写记录。
      const busyFingerprint = busyClock.get(clock.id);
      if (busyFingerprint && busyFingerprint !== fingerprint) {
        const error = new Error("该机芯已有体检正在处理，两个并发体检只能冻结一份结论，请稍后再试");
        error.status = 409;
        throw error;
      }

      let outcome;
      const job = store.mutate(async (draft) => {
          // 提交前钩子：此时已占用该机芯的并发槽，默认空操作；测试用它稳定并发窗口。
          await beforeCheckupCommit({ clockId: clock.id, fingerprint });
          const existing = draft.acousticCheckups.find((item) => item.fingerprint === fingerprint);
          if (existing) return { checkup: existing, duplicated: true, statusCode: 200 };

          const now = new Date().toISOString();
          const checkup = {
            id: makeId("acoustic"),
            clockId: clock.id,
            fingerprint,
            vph,
            balanceFrequency: body.balanceFrequency ?? clock.balanceFrequency,
            sampleCount: intervals.length,
            cleanedSampleCount: result.cleanedSampleCount,
            outlierCount: result.outlierCount,
            outlierIndexes: result.outlierIndexes,
            metrics: result.metrics,
            status: result.status,
            statusLabel: result.statusLabel,
            note: body.note || "",
            createdAt: now,
            reviews: [],
            versions: [
              {
                version: 1,
                status: result.status,
                statusLabel: result.statusLabel,
                reason: "首次体检结论",
                reviewer: "system",
                createdAt: now
              }
            ]
          };
          draft.acousticCheckups.push(checkup);
          return { checkup, duplicated: false, statusCode: 201 };
        });
      inFlight.set(fingerprint, job);
      busyClock.set(clock.id, fingerprint);
      try {
        outcome = await job;
      } finally {
        inFlight.delete(fingerprint);
        if (busyClock.get(clock.id) === fingerprint) busyClock.delete(clock.id);
      }
      return send(res, outcome.statusCode, { data: outcome.checkup, duplicated: outcome.duplicated, fingerprint });
    }

    if (checkupsMatch && req.method === "GET") {
      findClock(db, checkupsMatch[1]);
      const data = db.acousticCheckups
        .filter((item) => item.clockId === checkupsMatch[1])
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return send(res, 200, { data });
    }

    const checkupLatestMatch = pathname.match(/^\/clocks\/([^/]+)\/acoustic-checkups\/latest$/);
    if (checkupLatestMatch && req.method === "GET") {
      findClock(db, checkupLatestMatch[1]);
      return send(res, 200, { data: latestAcousticCheckup(db, checkupLatestMatch[1]) });
    }

    if (req.method === "GET" && pathname === "/acoustic-checkups") {
      const clockId = url.searchParams.get("clockId");
      const status = url.searchParams.get("status");
      const data = db.acousticCheckups
        .filter((item) => (!clockId || item.clockId === clockId) && (!status || item.status === status))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return send(res, 200, { data });
    }

    const reviewMatch = pathname.match(/^\/acoustic-checkups\/([^/]+)\/reviews$/);
    if (reviewMatch && req.method === "POST") {
      const body = await parseBody(req);
      required(body, ["action", "reason"]);
      if (!["confirm", "overturn"].includes(body.action)) {
        const error = new Error("action 只能是 confirm（维持）或 overturn（推翻）");
        error.status = 400;
        throw error;
      }
      const updated = await store.mutate((draft) => {
        const checkup = draft.acousticCheckups.find((item) => item.id === reviewMatch[1]);
        if (!checkup) {
          const error = new Error("体检记录不存在");
          error.status = 404;
          throw error;
        }
        const now = new Date().toISOString();
        const review = {
          id: makeId("review"),
          action: body.action,
          reason: body.reason,
          reviewer: body.reviewer || "watchmaker",
          fromStatus: checkup.status,
          toStatus: checkup.status,
          createdAt: now
        };

        if (body.action === "overturn") {
          required(body, ["newStatus"]);
          if (!["healthy", "attention", "abnormal"].includes(body.newStatus)) {
            const error = new Error("newStatus 只能是 healthy、attention 或 abnormal");
            error.status = 400;
            throw error;
          }
          if (body.newStatus === checkup.status) {
            const error = new Error(`新结论与当前结论「${checkup.statusLabel}」相同，不算推翻`);
            error.status = 400;
            throw error;
          }
          const labels = { healthy: "健康", attention: "关注", abnormal: "异常" };
          // 不就地改写：追加新版本，旧版本与原因永久保留。
          checkup.versions.push({
            version: checkup.versions.length + 1,
            status: body.newStatus,
            statusLabel: labels[body.newStatus],
            reason: body.reason,
            reviewer: review.reviewer,
            createdAt: now
          });
          checkup.status = body.newStatus;
          checkup.statusLabel = labels[body.newStatus];
          review.toStatus = body.newStatus;
        }

        checkup.reviews.push(review);
        return checkup;
      });
      return send(res, 201, { data: updated });
    }

    const checkupDetailMatch = pathname.match(/^\/acoustic-checkups\/([^/]+)$/);
    if (checkupDetailMatch) {
      const checkup = db.acousticCheckups.find((item) => item.id === checkupDetailMatch[1]);
      if (req.method === "GET") {
        if (!checkup) return send(res, 404, { error: "体检记录不存在" });
        return send(res, 200, { data: checkup });
      }
      // 结论不能直接改写：只允许经 /reviews 复核流程变更。
      if (["PUT", "PATCH", "DELETE", "POST"].includes(req.method)) {
        return send(res, 405, { error: "结论不允许直接改写，请使用 POST /acoustic-checkups/:id/reviews 复核" });
      }
    }

    if (req.method === "GET" && pathname === "/adjustments") {
      const clockId = url.searchParams.get("clockId");
      return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
    }

    if (req.method === "GET" && pathname === "/retests") {
      const clockId = url.searchParams.get("clockId");
      const qualified = url.searchParams.get("qualified");
      const data = db.retests.filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchQualified = qualified === null || item.qualified === (qualified === "true");
        return matchClock && matchQualified;
      });
      return send(res, 200, { data });
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
  });

  return { server, store };
}

function startServer(port = DEFAULT_PORT, dbFile = DEFAULT_DB_FILE) {
  const { server } = createApp(dbFile);
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Clock escapement tuning API running at http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, analyzeAcoustic, parseFrequency, MIN_VALID_SAMPLES };
