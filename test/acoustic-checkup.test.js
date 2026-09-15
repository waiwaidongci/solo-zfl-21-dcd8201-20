const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile } = require("fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const { createApp, analyzeAcoustic, parseFrequency, MIN_VALID_SAMPLES } = require("../server.js");

const BASE = "/clocks/clock_demo";

// 28800 vph -> 期望滴答周期 125ms。生成围绕该周期的对称零均值抖动与平稳摆幅。
// 自带 balanceFrequency，HTTP 提交时覆盖 clock_demo 的 18000vph，与 125ms 样本匹配。
function makeSamples(n, { interval = 125, jitter = 0.15, amplitude = 270, ampJitter = 2 } = {}) {
  const tickIntervalsMs = [];
  const amplitudesDeg = [];
  for (let i = 0; i < n; i++) {
    const wobble = (i % 5) - 2; // -2..2 对称重复，任意 5 的倍数样本严格零均值
    tickIntervalsMs.push(interval + wobble * jitter);
    amplitudesDeg.push(amplitude + ((i % 3) - 1) * ampJitter); // -1,0,1 对称
  }
  return { balanceFrequency: "28800vph", tickIntervalsMs, amplitudesDeg };
}

async function startHarness(hooks) {
  const dir = await mkdtemp(path.join(tmpdir(), "acoustic-"));
  const dbFile = path.join(dir, "db.json");
  const app = createApp(dbFile, hooks);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    dbFile,
    stop: () =>
      new Promise((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}

// 并发闸门：让首份体检在写库前阻塞，等第二个请求真正进入并发窗口后再放行，
// 避免在极快环境下两个“并发”请求被调度成前后两个独立请求。
function gate() {
  let enter;
  let go;
  const entered = new Promise((r) => {
    enter = r;
  });
  const released = new Promise((r) => {
    go = r;
  });
  let blockedOnce = false;
  return {
    entered,
    release: go,
    hook: async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        enter();
        await released;
      }
    }
  };
}

async function api(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function readPersisted(dbFile) {
  return JSON.parse(await readFile(dbFile, "utf8"));
}

/* ------------------------- 分析引擎：离群点、指标、分级 ------------------------- */

test("离群点被 MAD 判据剔除，剩余样本算出节拍偏差/噪声/稳定度", () => {
  const { tickIntervalsMs, amplitudesDeg } = makeSamples(40);
  tickIntervalsMs[5] = 400; // 明显的漏跳离群点
  tickIntervalsMs[20] = 30; // 明显的误触发离群点

  const result = analyzeAcoustic({ vph: 28800, tickIntervalsMs, amplitudesDeg });

  assert.equal(result.outlierCount, 2);
  assert.deepEqual(result.outlierIndexes, [5, 20]);
  assert.equal(result.cleanedSampleCount, 38);
  // 干净样本均值≈125ms：节拍偏差与日差接近 0
  assert.ok(Math.abs(result.metrics.beatErrorMs) < 0.5, `beatError=${result.metrics.beatErrorMs}`);
  assert.ok(Math.abs(result.metrics.dailyRateSeconds) < 60);
  assert.ok(result.metrics.intervalNoiseMs >= 0);
  assert.ok(result.metrics.stabilityPercent > 95);
  assert.equal(result.status, "healthy");
});

test("全部间隔完全一致时（MAD=0）退化为 5% 判据，不会误删正常样本", () => {
  const tickIntervalsMs = Array(25).fill(200); // 18000vph 期望 200ms
  const amplitudesDeg = Array(25).fill(280);
  const result = analyzeAcoustic({ vph: 18000, tickIntervalsMs, amplitudesDeg });
  assert.equal(result.outlierCount, 0);
  assert.equal(result.cleanedSampleCount, 25);
  assert.equal(result.status, "healthy");
});

test("节拍偏快/偏慢给出有符号日差，并触发关注或异常分级", () => {
  // 126ms vs 125ms 期望 -> 周期变长、日差为正（走慢）
  const slow = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { interval: 126, jitter: 0 }) });
  assert.ok(slow.metrics.dailyRateSeconds > 0);
  assert.ok(slow.metrics.beatErrorMs > 0);

  // 124.9ms -> 周期变短、日差为负（走快）
  const fast = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { interval: 124.9, jitter: 0 }) });
  assert.ok(fast.metrics.dailyRateSeconds < 0);
  assert.ok(fast.metrics.beatErrorMs < 0);

  // 轻微偏差（约 +69s/天）-> 超过 60s 阈值，异常
  const abnormal = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { interval: 125.1, jitter: 0 }) });
  assert.ok(abnormal.metrics.dailyRateSeconds > 60);
  assert.equal(abnormal.status, "abnormal");

  // 更轻微偏差（约 +35s/天）-> 关注但未到异常
  const attention = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { interval: 125.05, jitter: 0 }) });
  assert.ok(attention.metrics.dailyRateSeconds > 20 && attention.metrics.dailyRateSeconds <= 60);
  assert.equal(attention.status, "attention");
});

test("摆幅不足判为异常，摆幅偏低判为关注", () => {
  const low = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { amplitude: 190, ampJitter: 1 }) });
  assert.equal(low.status, "abnormal");

  const attention = analyzeAcoustic({ vph: 28800, ...makeSamples(30, { amplitude: 210, ampJitter: 1 }) });
  assert.equal(attention.status, "attention");
});

test("parseFrequency 兼容 vph / 纯数字 / Hz 写法", () => {
  assert.equal(parseFrequency("28800vph"), 28800);
  assert.equal(parseFrequency("18000"), 18000);
  assert.equal(parseFrequency("4Hz"), 14400);
  assert.equal(parseFrequency(4), 14400);
  assert.equal(parseFrequency("garbage"), null);
});

/* ------------------------- 样本边界 ------------------------- */

test("恰好 20 个有效样本：接受并写记录", async () => {
  const h = await startHarness();
  try {
    const { status, json } = await api(h.base, "POST", `${BASE}/acoustic-checkups`, makeSamples(20));
    assert.equal(status, 201);
    assert.equal(json.data.cleanedSampleCount, 20);
    assert.equal(json.duplicated, false);

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 1);
  } finally {
    await h.stop();
  }
});

test("19 个样本：422 拒绝且不写任何记录", async () => {
  const h = await startHarness();
  try {
    const { status, json } = await api(h.base, "POST", `${BASE}/acoustic-checkups`, makeSamples(19));
    assert.equal(status, 422);
    assert.match(json.error, new RegExp(`少于${MIN_VALID_SAMPLES}`));

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 0);
  } finally {
    await h.stop();
  }
});

test("提交 22 个但离群剔除后只剩 19 个有效：仍然 422 且不写", async () => {
  const h = await startHarness();
  try {
    const payload = makeSamples(22);
    // 注入 3 个离群点，清洗后 19 < 20
    payload.tickIntervalsMs[0] = 500;
    payload.tickIntervalsMs[10] = 5;
    payload.tickIntervalsMs[21] = 480;
    const { status, json } = await api(h.base, "POST", `${BASE}/acoustic-checkups`, payload);
    assert.equal(status, 422);
    assert.match(json.error, /剔除3个离群点后/);

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 0);
  } finally {
    await h.stop();
  }
});

test("序列为空/长度不一致/含非法数字：400", async () => {
  const h = await startHarness();
  try {
    const empty = await api(h.base, "POST", `${BASE}/acoustic-checkups`, {
      tickIntervalsMs: [],
      amplitudesDeg: []
    });
    assert.equal(empty.status, 400);

    const mismatched = await api(h.base, "POST", `${BASE}/acoustic-checkups`, {
      tickIntervalsMs: Array(20).fill(125),
      amplitudesDeg: Array(19).fill(270)
    });
    assert.equal(mismatched.status, 400);

    const badNumber = await api(h.base, "POST", `${BASE}/acoustic-checkups`, {
      tickIntervalsMs: ["x", ...Array(19).fill(125)],
      amplitudesDeg: Array(20).fill(270)
    });
    assert.equal(badNumber.status, 400);

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 0);
  } finally {
    await h.stop();
  }
});

/* ------------------------- 重复提交 ------------------------- */

test("同一采样重复提交（串行）：第二次返回首份、200+duplicated，只存一条", async () => {
  const h = await startHarness();
  try {
    const payload = makeSamples(24);
    const first = await api(h.base, "POST", `${BASE}/acoustic-checkups`, payload);
    assert.equal(first.status, 201);
    assert.equal(first.json.duplicated, false);

    const second = await api(h.base, "POST", `${BASE}/acoustic-checkups`, payload);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicated, true);
    assert.equal(second.json.data.id, first.json.data.id);

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 1);
  } finally {
    await h.stop();
  }
});

/* ------------------------- 并发 ------------------------- */

test("同一采样两个并发提交：只冻结一份结论（一条 201 一条 200，同 ID）", async () => {
  const g = gate();
  const h = await startHarness({ beforeCheckupCommit: g.hook });
  try {
    const payload = makeSamples(24);
    const first = api(h.base, "POST", `${BASE}/acoustic-checkups`, payload);
    await g.entered; // 首份已进入并发窗口并持有槽位

    const second = api(h.base, "POST", `${BASE}/acoustic-checkups`, payload); // 同采样并发到达
    g.release(); // 放行首份提交

    const [a, b] = await Promise.all([first, second]);
    const created = [a, b].filter((r) => r.status === 201);
    const deduped = [a, b].filter((r) => r.status === 200);
    assert.equal(created.length, 1);
    assert.equal(deduped.length, 1);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(deduped[0].json.duplicated, true);

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 1);
  } finally {
    g.release();
    await h.stop();
  }
});

test("不同采样两个并发体检同一机芯：只冻结一份，另一份 409 且不写", async () => {
  const g = gate();
  const h = await startHarness({ beforeCheckupCommit: g.hook });
  try {
    const p1 = makeSamples(24, { interval: 125 });
    const p2 = makeSamples(24, { interval: 126 });
    const first = api(h.base, "POST", `${BASE}/acoustic-checkups`, p1);
    await g.entered; // 首份正持有该机芯的并发槽

    // 第二份在首份未完成时到达 -> 409，且不进入提交流程
    const rejected = await api(h.base, "POST", `${BASE}/acoustic-checkups`, p2);
    assert.equal(rejected.status, 409);
    assert.match(rejected.json.error, /只能冻结一份/);

    g.release(); // 放行首份
    const accepted = await first;
    assert.equal(accepted.status, 201, "恰好一份被冻结");

    const db = await readPersisted(h.dbFile);
    assert.equal(db.acousticCheckups.length, 1);

    // 首份处理完后，被拒采样可以重新提交成功（并发槽已释放）
    const retry = await api(h.base, "POST", `${BASE}/acoustic-checkups`, p2);
    assert.equal(retry.status, 201);
    const db2 = await readPersisted(h.dbFile);
    assert.equal(db2.acousticCheckups.length, 2);
  } finally {
    g.release();
    await h.stop();
  }
});

/* ------------------------- 复核：不可直接改写、推翻保留版本 ------------------------- */

test("结论不能直接改写：PUT/PATCH/DELETE 返回 405", async () => {
  const h = await startHarness();
  try {
    const created = await api(h.base, "POST", `${BASE}/acoustic-checkups`, makeSamples(24));
    const id = created.json.data.id;
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${h.base}/acoustic-checkups/${id}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "healthy" })
      });
      assert.equal(res.status, 405, `${method} 应被拒绝`);
    }
    // 原结论未被改动
    const detail = await api(h.base, "GET", `/acoustic-checkups/${id}`);
    assert.equal(detail.json.data.status, created.json.data.status);
  } finally {
    await h.stop();
  }
});

test("复核推翻结论：当前结论更新，旧版本与原因完整保留", async () => {
  const h = await startHarness();
  try {
    // 先造一份异常结论
    const created = await api(
      h.base,
      "POST",
      `${BASE}/acoustic-checkups`,
      makeSamples(30, { amplitude: 190, ampJitter: 1 })
    );
    assert.equal(created.json.data.status, "abnormal");
    const id = created.json.data.id;

    const review = await api(h.base, "POST", `/acoustic-checkups/${id}/reviews`, {
      action: "overturn",
      newStatus: "healthy",
      reason: "实测为麦克风底座松动导致的伪影，换测点后摆幅正常",
      reviewer: "王师傅"
    });
    assert.equal(review.status, 201);
    assert.equal(review.json.data.status, "healthy");
    assert.equal(review.json.data.statusLabel, "健康");

    // versions 里旧版本 abnormal 与新版本 healthy 都在，且各自带原因
    assert.equal(review.json.data.versions.length, 2);
    const [v1, v2] = review.json.data.versions;
    assert.equal(v1.version, 1);
    assert.equal(v1.status, "abnormal");
    assert.equal(v1.reason, "首次体检结论");
    assert.equal(v2.version, 2);
    assert.equal(v2.status, "healthy");
    assert.match(v2.reason, /麦克风底座松动/);
    assert.equal(v2.reviewer, "王师傅");

    // 复核流水也保留了从->到
    assert.equal(review.json.data.reviews.length, 1);
    assert.equal(review.json.data.reviews[0].fromStatus, "abnormal");
    assert.equal(review.json.data.reviews[0].toStatus, "healthy");

    // 推翻为相同结论应被拒绝
    const same = await api(h.base, "POST", `/acoustic-checkups/${id}/reviews`, {
      action: "overturn",
      newStatus: "healthy",
      reason: "不应成立"
    });
    assert.equal(same.status, 400);

    // 维持（confirm）不改状态但追加流水
    const confirm = await api(h.base, "POST", `/acoustic-checkups/${id}/reviews`, {
      action: "confirm",
      reason: "二次听音确认良好"
    });
    assert.equal(confirm.status, 201);
    assert.equal(confirm.json.data.status, "healthy");
    assert.equal(confirm.json.data.versions.length, 2);
    assert.equal(confirm.json.data.reviews.length, 2);

    // 未知体检记录复核 -> 404
    const missing = await api(h.base, "POST", `/acoustic-checkups/acoustic_nope/reviews`, {
      action: "confirm",
      reason: "x"
    });
    assert.equal(missing.status, 404);
  } finally {
    await h.stop();
  }
});

/* ------------------------- 持久化：重启后数据仍在 ------------------------- */

test("服务重启后体检结论与复核版本仍然存在", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acoustic-restart-"));
  const dbFile = path.join(dir, "db.json");
  let checkupId;
  try {
    {
      const app = createApp(dbFile);
      await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${app.server.address().port}`;
      const created = await api(base, "POST", `${BASE}/acoustic-checkups`, makeSamples(24));
      checkupId = created.json.data.id;
      await api(base, "POST", `/acoustic-checkups/${checkupId}/reviews`, {
        action: "overturn",
        newStatus: "attention",
        reason: "重启持久化验证用"
      });
      await new Promise((res, rej) => app.server.close((e) => (e ? rej(e) : res())));
    }
    {
      // 用同一个 dbFile 起一个全新进程内实例，模拟重启
      const app = createApp(dbFile);
      await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${app.server.address().port}`;
      const detail = await api(base, "GET", `/acoustic-checkups/${checkupId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.data.status, "attention");
      assert.equal(detail.json.data.versions.length, 2);
      assert.match(detail.json.data.versions[1].reason, /重启持久化验证用/);
      await new Promise((res, rej) => app.server.close((e) => (e ? rej(e) : res())));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------- 旧接口回归 ------------------------- */

test("旧接口全部可用：钟表/调校/复测/筛选/历史", async () => {
  const h = await startHarness();
  try {
    // health
    const health = await api(h.base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    // 种子数据
    const clocks = await api(h.base, "GET", "/clocks");
    assert.equal(clocks.status, 200);
    assert.equal(clocks.json.data.length, 1);
    assert.equal(clocks.json.data[0].id, "clock_demo");
    // 新字段为 null，不破坏旧结构
    assert.equal(clocks.json.data[0].latestAcousticCheckup, null);

    const notQualified = await api(h.base, "GET", "/clocks/not-qualified");
    assert.equal(notQualified.status, 200);
    assert.ok(notQualified.json.data.some((c) => c.id === "clock_demo"));

    // 新建钟表
    const created = await api(h.base, "POST", "/clocks", {
      code: "T-001",
      escapementType: "同轴式",
      balanceFrequency: "28800vph",
      targetDailyRateSeconds: 10
    });
    assert.equal(created.status, 201);
    const newId = created.json.data.id;

    // 加调校
    const adj = await api(h.base, "POST", `/clocks/${newId}/adjustments`, {
      currentDailyRateSeconds: 25,
      direction: "快针方向",
      amount: "微调0.2格"
    });
    assert.equal(adj.status, 201);

    // 加复测，合格
    const retest = await api(h.base, "POST", `/clocks/${newId}/retests`, {
      dailyRateSeconds: 5,
      amplitude: 280
    });
    assert.equal(retest.status, 201);
    assert.equal(retest.json.data.qualified, true);

    // qualified 筛选
    const qualifiedOnly = await api(h.base, "GET", "/clocks?qualified=true");
    assert.ok(qualifiedOnly.json.data.some((c) => c.id === newId));

    // 历史里包含新的 acousticCheckups 数组且旧数据仍在
    const history = await api(h.base, "GET", `/clocks/${newId}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.json.data.adjustments.length, 1);
    assert.equal(history.json.data.retests.length, 1);
    assert.deepEqual(history.json.data.acousticCheckups, []);

    // 列表接口与 latest-retest
    const adjustments = await api(h.base, "GET", `/adjustments?clockId=${newId}`);
    assert.equal(adjustments.json.data.length, 1);
    const retests = await api(h.base, "GET", `/retests?clockId=${newId}&qualified=true`);
    assert.equal(retests.json.data.length, 1);
    const latest = await api(h.base, "GET", `/clocks/${newId}/latest-retest`);
    assert.equal(latest.json.data.dailyRateSeconds, 5);

    // 404
    const nf = await api(h.base, "GET", "/clocks/no-such/history");
    assert.equal(nf.status, 404);
  } finally {
    await h.stop();
  }
});

test("体检查询接口：列表、按状态过滤、latest、钟表摘要带上最新结论", async () => {
  const h = await startHarness();
  try {
    const healthy = await api(h.base, "POST", `${BASE}/acoustic-checkups`, makeSamples(24));
    assert.equal(healthy.status, 201);

    const list = await api(h.base, "GET", `${BASE}/acoustic-checkups`);
    assert.equal(list.json.data.length, 1);

    const latest = await api(h.base, "GET", `${BASE}/acoustic-checkups/latest`);
    assert.equal(latest.json.data.id, healthy.json.data.id);

    const filtered = await api(h.base, "GET", `/acoustic-checkups?status=healthy`);
    assert.equal(filtered.json.data.length, 1);
    const filteredNone = await api(h.base, "GET", `/acoustic-checkups?status=abnormal`);
    assert.equal(filteredNone.json.data.length, 0);

    const summary = await api(h.base, "GET", "/clocks");
    const demo = summary.json.data.find((c) => c.id === "clock_demo");
    assert.equal(demo.latestAcousticCheckup.status, "healthy");
  } finally {
    await h.stop();
  }
});
