# ACLClouds Auto-Renew

ACLClouds Free Bot 托管自动续期。Free 套餐约 4 天到期，到期前 2 天才开放续期。脚本用账号密码登录（登录验证码为 Cap 工作量证明组件，自动求解），发现服务 id，UI + API 双路径续期，并回读订阅接口校验到期时间真的后移。GitHub Actions 每两天跑一次，422 未到窗口时脚本会按到期时间睡到开窗再重试（≤5h），等效跟着到期时间调度。

## 做什么

1. Playwright 打开 `/auth/login`，填账号密码，自动求解 `cap-widget`（无感直通或 PoW，约 3-10s）
2. 登录进 dashboard，通过 `/api/client/credits/subscriptions`（兼容旧版 `/api/client`）发现服务
3. 优先访问 `/server/:id` 点 UI 续期按钮；点击后轮询订阅接口，确认 `expires_at` 后移才判成功，否则转入 API 兜底
4. API 续期 `POST /api/client/hosting/apps/{uuid}/renew`（新端点 404 时回退旧路径 `/api/client/servers/{id}/upgrade/renew`）
   - `2xx` 续期成功（回读订阅接口校验到期时间，写入 TG 消息）
   - `422 renew_too_early` 未到窗口（按成功跳过处理）
   - `403 captcha_required` 过一次 Cap 验证码后带 token 重试
   - 其它状态当失败
5. Telegram 通知（见下）

## Telegram

| 结果 | 发什么 |
|---|---|
| 续期成功 | 一条最终状态（含新到期时间），不带图 |
| 未到续期窗口 | 一条最终状态（剩余天数），不带图 |
| DRY_RUN | 标题带 🧪 演练标识，不提交续期 |
| 续期失败 / 崩溃 | 最终状态 + 失败截图 |

登录、验证码过程不发 TG。本地仍会把全过程截图写到 `shots/`。

## GitHub Actions

`.github/workflows/renew.yml`：每两天 UTC `16:32`（北京时间 0:32），也可手动 Run workflow。

到期自适应：API 返回 `422 renew_too_early` 时，脚本按 `到期时间 - 48h` 计算开窗时刻，若在 job 预算内（≤5h）则睡到开窗后重试一次；超出预算则留给下一次 cron（48h 窗口 × 48h 间隔，必有一次落在窗口内）。

Keepalive：公开仓库 60 天无 commit 会被 GitHub 自动停用 scheduled workflow。定时运行时若距上次 keepalive 提交 ≥30 天，会自动提交 `.github/.keepalive`（github-actions[bot] 身份）保持活跃。

Secrets（两套命名二选一，都配则以 `ACL_` 为准）：

| 名 | 用途 |
|---|---|
| `ACL_USERNAME` / `ACL_PASSWORD` | 登录账号（也支持 `EMAIL`/`PASSWORD`；`EMAIL_2`/`PASSWORD_2` … 最多 4 个账号） |
| `ACL_SERVER_ID` | 可选；留空自动发现全部服务 |
| `TG_BOT_TOKEN` | Telegram bot token |
| `TG_CHAT_ID` | Telegram chat id |

Variable（可选）：`ACL_BASE_URL`，默认 `https://aclclouds.com`

登录会话缓存为 `auth-N.json`（Actions cache），命中则跳过验证码；失效自动删除重登。

## 本地跑

```bash
cp .env.example .env   # 填账号、TG
npm install
npx playwright install chromium
node with-env.cjs
```

`DRY_RUN=1` 只登录和发现服务，不 POST renew。

## 已完成 / 待做

**已完成**

- 账号密码登录，`cap-widget` 自动求解；会话缓存命中则跳过
- 订阅接口发现服务；未设 `ACL_SERVER_ID` 时逐台续期
- UI + API 双路径续期；UI 点击后回读订阅接口校验 `expires_at` 后移，避免静态文本误判成功
- `422 renew_too_early` 视为未到窗口；`403 captcha_required` 过 Cap 盾后带 token 重试
- 续期成功后校验到期时间并写入 TG
- Actions 每两天定时（北京 0:32）+ Secrets / Variable；Playwright 安装带 apt DNS 容错与浏览器缓存
- 422 后按到期时间睡等到窗口打开再重试（≤5h/job 预算），续期时点紧贴开窗
- 2026-11-12 实测：窗口内 UI 续期成功，到期 11-13 → 11-17 (+4 天)

**待做**

- `403 captcha_required` 路径尚未在真实窗口内触发过，触发时需按日志核对 Cap token 提交格式
- 旧版 OCR 四选一验证码兜底（`/auth/captcha/challenge`）站点已改版，大概率失效，仅作降级保留
- OCR 极端扭曲图仍可能卡死（认空/认错会换题，最多 4 次）
