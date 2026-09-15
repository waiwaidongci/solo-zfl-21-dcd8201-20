# 机械钟表擒纵调校 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录，以及新增的**擒纵声学体检**。

## 启动

```bash
PORT=3021 node server.js
# 或
npm start
```

## 测试

```bash
npm test          # node --test，零依赖
```

覆盖：左右交替失衡（成对节拍偏差）、成对缺失、离群点不污染成对统计、样本边界（19/20、剔除后不足）、原始序列持久化与重启可读、旧数据迁移（缺原序列标缺失且不改结论）、重复提交、并发（同采样去重 / 不同采样只冻结一份 / 迁移与写不产生半条记录）、复核推翻与版本保留、旧接口回归。

## 原有接口（保持不变）

- `GET /health`
- `GET /clocks`（`?qualified=true|false`；摘要新增 `latestAcousticCheckup` 字段，无体检时为 `null`）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（返回体新增 `acousticCheckups` 数组与 `latestAcousticCheckup`）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 擒纵声学体检

每次体检按机芯频率，提交**有顺序**的滴答间隔序列与摆幅序列。服务先做稳健离群剔除，再计算节拍偏差、噪声、稳定度并给出健康分级。

### 提交体检

`POST /clocks/:id/acoustic-checkups`

```json
{
  "balanceFrequency": "28800vph",
  "tickIntervalsMs": [125.1, 124.8, 400, 125.0],
  "amplitudesDeg": [272, 270, 268, 271],
  "note": "可选"
}
```

- `balanceFrequency` 可省略，默认用钟表档案上的频率；支持 `28800vph`、`28800`、`4Hz`（Hz 按 ×3600 换算）。
- 两个序列必须等长、滴答间隔为正数、摆幅非负，否则 `400`。
- **有效样本（剔除离群点后）少于 20 个：返回 `422`，拒绝且不写任何记录。**
- 成功 `201`，返回体含 `metrics`、`status`、`statusLabel`、`outlierCount`、`outlierIndexes`、`fingerprint`、`versions`，以及完整有序的 `tickIntervalsMs` / `amplitudesDeg` 与 `rawSamplesAvailable`。

### 离群剔除与指标

- 以滴答间隔中位数的 **MAD（中位绝对偏差）3.5 倍**为稳健阈值剔除离群点（漏跳/误触发）；MAD 为 0（走时极均匀）时退化为「与期望周期偏差 > 5%」判据，避免误删正常滴答。
- 指标：
  - `beatErrorMs` **节拍偏差（左右失衡）**：擒纵左右交替发声，若取「平均周期 − 目标周期」，左右两半周期的长短差会相互抵消而恒为零。因此用清洗后**仍相邻**的有效滴答组成左右对，取每对失衡 `|左−右| / 2`，再跨对取**中位数**（稳健）。被离群点打断的相邻对跳过，离群滴答不参与统计；没有任何成对样本时为 `null`。配套字段 `beatErrorAvailable` 与 `beatPairCount`。
  - `dailyRateSeconds` **日差（秒/天，带符号）仍按平均周期与目标周期之差计算**，不因节拍偏差口径变化而改动。
  - `intervalNoiseMs` 噪声 = 间隔标准差；`noiseRatioPercent` = 噪声 / 期望周期
  - `stabilityPercent` 稳定度 = 100 − 噪声占比
  - `avgAmplitudeDeg`、`amplitudeStdDevDeg`、`amplitudeDropDeg`（首末摆幅差）
- 分级 `status` / `statusLabel`：
  - `healthy` 健康
  - `attention` 关注：|日差| > 20s、噪声占比 > 1%、平均摆幅 < 220°、摆幅标准差 > 20°
  - `abnormal` 异常：|日差| > 60s、噪声占比 > 2%、平均摆幅 < 200°、摆幅衰退 ≥ 30°

### 原始序列持久化与旧数据迁移

- 每条体检记录**原样保存完整、有序的 `tickIntervalsMs` 与 `amplitudesDeg`**，重启后经详情/列表接口仍可返回，供人工复核；`rawSamplesAvailable:true` 标明原序列可得。钟表摘要只带 `rawSamplesAvailable` 标记，不内联大序列。
- 升级前写入的旧记录没有原序列：读取时标记 `rawSamplesAvailable:false`、两序列返回 `null`、`metrics.beatErrorAvailable:false`，且**不会据此重算或覆盖原结论/旧指标**。服务启动时经写队列做一次性原子迁移补标，迁移与并发体检写入都不会产生半条记录。

### 重复与并发

- 同一采样（时钟 ID + 频率 + 两条序列的指纹）**重复提交只返回首份结论**：首次 `201 duplicated:false`，之后（含并发同时到达）`200 duplicated:true` 且 ID 相同，库里始终只有一条。
- **两个并发体检（不同采样）同一机芯，只能冻结一份结论**：先到的 `201`，后到的 `409` 且不写；待首份结束后被拒采样可重新提交。

### 查询

- `GET /clocks/:id/acoustic-checkups`：该机芯的体检列表（新到旧）
- `GET /clocks/:id/acoustic-checkups/latest`：最新一份
- `GET /acoustic-checkups?clockId=&status=healthy|attention|abnormal`：全局过滤
- `GET /acoustic-checkups/:id`：详情（含 `metrics`、`reviews`、`versions`）

### 复核（结论不能直接改写）

`POST /acoustic-checkups/:id/reviews`

```json
{ "action": "overturn", "newStatus": "healthy", "reason": "麦克风底座松动造成伪影", "reviewer": "王师傅" }
```

- `action`：`confirm`（维持）或 `overturn`（推翻，需给合法 `newStatus`，且不能与当前结论相同）。
- 结论**不允许** `PUT/PATCH/DELETE`，一律 `405`；只能走复核。
- 推翻时**不就地改写**：当前 `status` 更新，同时在 `versions` 追加新版本，旧版本状态、原因、复核人、时间永久保留；`reviews` 记录每次 `fromStatus → toStatus`。

## 持久化与并发安全

- 所有写操作经单一写队列串行化（读—改—写），并以「临时文件 + 原子 rename」落盘，重启后数据仍在。
- 数据文件缺少 `acousticCheckups` 键时自动兼容归一化，旧数据可直接升级。

## 闭环示例

```bash
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/acoustic-checkups \
  -H 'Content-Type: application/json' \
  -d '{"balanceFrequency":"18000vph","tickIntervalsMs":[200,200.1,...],"amplitudesDeg":[250,251,...]}'

curl -X POST http://127.0.0.1:3021/acoustic-checkups/<id>/reviews \
  -H 'Content-Type: application/json' \
  -d '{"action":"overturn","newStatus":"healthy","reason":"换测点重测正常"}'
```
