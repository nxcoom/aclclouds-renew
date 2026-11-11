#!/usr/bin/env node
import { chromium } from 'playwright';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// 多账号支持: ACL_ACCOUNTS (JSON 数组) 或兼容两仓库名命:
//   bigxbossm 仓: ACL_USERNAME / ACL_PASSWORD, ACL_USERNAME_2 / ACL_PASSWORD_2 ...
//   kanezikii 仓: EMAIL / PASSWORD, EMAIL_2 / PASSWORD_2 ...
function loadAccounts() {
  const accounts = [];
  if (process.env.ACL_ACCOUNTS) {
    try {
      for (const a of JSON.parse(process.env.ACL_ACCOUNTS)) {
        const u = a.username || a.user || a.email || '';
        const p = a.password || a.pass || '';
        if (u && p) accounts.push({ user: u, pass: p });
      }
    } catch (e) {
      log(`ACL_ACCOUNTS 解析失败: ${e.message}`);
    }
  }
  if (!accounts.length) {
    const u1 = process.env.ACL_USERNAME || process.env.ACL_EMAIL || process.env.EMAIL || '';
    const p1 = process.env.ACL_PASSWORD || process.env.PASSWORD || '';
    if (u1 && p1) accounts.push({ user: u1, pass: p1 });
    for (const k of [2, 3, 4]) {
      const u = process.env[`ACL_USERNAME_${k}`] || process.env[`ACL_EMAIL_${k}`] || process.env[`EMAIL_${k}`] || '';
      const p = process.env[`ACL_PASSWORD_${k}`] || process.env[`PASSWORD_${k}`] || '';
      if (u && p) accounts.push({ user: u, pass: p });
    }
  }
  return accounts;
}
const SHOT = path.resolve('shots');
const VOCAB = [
  'Panel', 'VPS', 'Bot', 'Serveur', 'Cloud', 'ACLClouds',
  'Minecraft', 'Discord', 'Housing', 'Tunnel', 'Dedicated',
  'Free', 'Upgrade', 'Renew', 'Game', 'Node', 'Credit', 'Support'
];

fs.mkdirSync(SHOT, { recursive: true });
const shots = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function score(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return Math.max(0, 100 - dp[a.length][b.length] * 25);
}

function ocrScore(text, guess, prompt) {
  return Math.max(score(text, prompt), score(guess, prompt));
}

async function shot(page, name) {
  const p = path.join(SHOT, name);
  await page.screenshot({ path: p, fullPage: true });
  shots.push(p);
  log(`截图 ${name}`);
  return p;
}

async function sendTgPhoto(chat, token, photoPath, caption) {
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    if (caption) form.append('caption', caption);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!r.ok) log(`TG 图片发送失败 ${path.basename(photoPath)}: ${await r.text()}`);
    else log(`TG 图片已发送: ${path.basename(photoPath)}`);
  } catch (e) {
    log(`TG 图片发送异常: ${e.message}`);
  }
}

async function tg(text, { photo = null } = {}) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  try {
    const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!msg.ok) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
    }
    log('TG 文本已发送');
  } catch (e) {
    log(`TG 发送异常 (非致命): ${e.message}`);
  }

  if (photo) {
    await sendTgPhoto(chat, token, photo);
  }
}

function formatTgMessage({ failed, results = [], errorMsg = '' }) {
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const hasRenewed = results.some((r) => r.ok && !r.skip);
  const allSkipped = results.length > 0 && results.every((r) => r.ok && r.skip);

  let title = '✅ <b>【ACLClouds 自动续期成功】</b>';
  let badge = '🎉 服务续期成功';
  if (failed) {
    title = '❌ <b>【ACLClouds 自动续期失败】</b>';
    badge = '⚠️ 续期任务异常';
  } else if (allSkipped) {
    title = '⏳ <b>【ACLClouds 续期检查 - 未到窗口】</b>';
    badge = 'ℹ️ 暂未到可续期时间';
  }

  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    `🕒 <b>执行时间</b>: ${beijingTime} (北京时间)`,
    `📊 <b>任务状态</b>: ${badge}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '<b>服务详情</b>:',
  ];

  if (failed && errorMsg) {
    lines.push(`• 异常原因: ${errorMsg}`);
  }

  for (const r of results) {
    const icon = r.ok ? (r.skip ? '⏳' : '✅') : '❌';
    lines.push(`• ${icon} ${r.text}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (failed) {
    lines.push('⚠️ 请及时查看 GitHub Actions 运行日志与失败截图排查。');
  } else if (hasRenewed) {
    lines.push('✨ 服务已成功延期，将在下次预定周期继续自动守护。');
  } else {
    lines.push('📌 站点限制到期前 2 天方可续期，下次执行将自动处理。');
  }

  return lines.join('\n');
}

async function ocrPick(dir, prompt, n) {
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '7',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  });
  const results = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `${i}.png`);
    const r = await worker.recognize(file);
    const text = (r.data.text || '').replace(/\s+/g, '').trim();
    const best = VOCAB.map((v) => ({ v, s: score(text, v) })).sort((p, q) => q.s - p.s)[0];
    results.push({ i, text, guess: best.v, vsPrompt: ocrScore(text, best.v, prompt) });
  }
  await worker.terminate();
  results.sort((a, b) => b.vsPrompt - a.vsPrompt);
  log(`OCR prompt=${prompt} ${results.map((x) => `${x.i}:${x.text || x.guess}(${x.vsPrompt})`).join(' ')}`);
  if (!results[0] || results[0].vsPrompt < 75) throw new Error(`OCR 未匹配 ${prompt}: ${JSON.stringify(results)}`);
  return results[0].i;
}

async function solveCaptcha(page, prefix = '') {
  const root = prefix ? `${prefix} ` : '';
  const checkbox = page.locator(`${root}div[role='checkbox']`).first();
  await checkbox.click();
  await page.waitForSelector(`${root}.auth-captcha-option-img`, { timeout: 20000 });
  await page.waitForFunction(
    (sel) => {
      const imgs = [...document.querySelectorAll(sel)];
      return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0 && i.clientHeight > 0);
    },
    `${root}.auth-captcha-option-img`,
    { timeout: 20000 }
  );

  const promptRaw = await page.locator(`${root}.auth-captcha-prompt`).innerText();
  const prompt = promptRaw.replace(/^(?:Click on|Cliquez sur)\s+/i, '').trim();
  const imgs = page.locator(`${root}.auth-captcha-option-img`);
  const n = await imgs.count();
  const dir = path.join(SHOT, 'captcha');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const src = await imgs.nth(i).getAttribute('src');
    const url = src.startsWith('http') ? src : BASE + src;
    const bytes = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, url);
    fs.writeFileSync(path.join(dir, `${i}.png`), Buffer.from(bytes));
  }
  await shot(page, '02-captcha.png');
  const pick = await ocrPick(dir, prompt, n);
  await page.locator(`${root}.auth-captcha-option`).nth(pick).evaluate((el) => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
    `${root}div[role='checkbox']`,
    { timeout: 15000 }
  );
  log(`验证码通过: ${prompt} -> option ${pick + 1}`);
}

async function solveCaptchaApi(page, context = 'renewal_gate') {
  log(`通过 API 求解验证码 (context: ${context})...`);
  const challengeRes = await api(page, `/auth/captcha/challenge?context=${encodeURIComponent(context)}`);
  if (challengeRes.status !== 200 || !challengeRes.data?.id) {
    throw new Error(`获取验证码 challenge 失败: HTTP ${challengeRes.status}`);
  }
  const chal = challengeRes.data;
  await page.waitForTimeout(1200);

  const initialVerify = await api(page, '/auth/captcha', 'POST', {
    context: chal.context || context,
    id: chal.id,
    ts: chal.ts,
    sig: chal.sig,
    elapsed: 1400,
  });

  if (initialVerify.status !== 200) {
    throw new Error(`验证码初始验证失败: HTTP ${initialVerify.status}`);
  }

  const ver = initialVerify.data;
  if (ver.passed && ver.token) {
    log('验证码无感直通成功');
    return ver.token;
  }

  if (!ver.interactive || !ver.target || !Array.isArray(ver.options)) {
    throw new Error(`验证码返回非交互态: ${JSON.stringify(ver)}`);
  }

  const target = ver.target;
  const options = ver.options;
  const dir = path.join(SHOT, 'captcha_api');
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < options.length; i++) {
    const imgUrl = `${BASE}/auth/captcha/image?t=${encodeURIComponent(options[i])}`;
    const bytes = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, imgUrl);
    fs.writeFileSync(path.join(dir, `${i}.png`), Buffer.from(bytes));
  }

  const pick = await ocrPick(dir, target, options.length);
  const selectedOption = options[pick];

  const submitVerify = await api(page, '/auth/captcha', 'POST', {
    context: ver.context || context,
    id: ver.id,
    ts: ver.ts,
    sig: ver.sig,
    answer: selectedOption,
    answer_sig: ver.answer_sig || '',
    target: target,
  });

  if (submitVerify.status === 200 && submitVerify.data?.passed && submitVerify.data?.token) {
    log(`API 验证码成功解决: ${target} -> token 获得`);
    return submitVerify.data.token;
  }
  throw new Error(`API 验证码选项提交未通过: ${JSON.stringify(submitVerify.data)}`);
}

async function api(page, p, method = 'GET', body) {
  return page.evaluate(async ({ p, method, body }) => {
    // 2026-11 改版: 认证 API 以 <meta name="csrf-token"> 为准。
    // XSRF-TOKEN cookie 是加密值且与会话不同步, POST 会 419/401。
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const cookieToken = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const res = await fetch(p, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(metaToken
          ? { 'X-CSRF-TOKEN': metaToken }
          : cookieToken
            ? { 'X-XSRF-TOKEN': decodeURIComponent(cookieToken) }
            : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 400); }
    return { status: res.status, data };
  }, { p, method, body });
}

async function loggedIn(page) {
  if (/\/dashboard/i.test(page.url())) return true;
  const r = await api(page, '/api/client/account');
  return r.status === 200 && r.data?.object === 'user';
}

async function dismissCookieConsent(page) {
  for (const t of ['Accept all', 'Reject all']) {
    const b = page.getByText(t, { exact: true }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await page.waitForTimeout(800);
      log(`已关闭 Cookie 同意弹窗 (${t})`);
      return;
    }
  }
}

async function solveLoginCap(page, attempt = 0) {
  // 2026-11 新版 Cap 组件: 触发器是 shadowRoot 内 .captcha-trigger(role=button),
  // 点击后自动进行工作量证明求解(约 3-10 秒), 完成后 token 写入 input[name=cap-token]。
  // 旧版的 div[role=checkbox] 与登录四选一图验证码均已移除。
  const ok = await page.evaluate(() => {
    const el = document.querySelector('cap-widget');
    if (!el) return false;
    const t = el.shadowRoot?.querySelector('.captcha-trigger') || el.querySelector('.captcha-trigger');
    if (t) { t.click(); return true; }
    return false;
  });
  if (!ok) throw new Error('未找到 cap-widget 触发器');
  log(`Cap 验证码自动求解中 (第 ${attempt + 1} 次)...`);
  await page.waitForFunction(() => {
    const el = document.querySelector('cap-widget');
    const v = el && el.querySelector('input[name=cap-token]');
    return !!(v && v.value && v.value.length > 10);
  }, { timeout: 45000 });
  log('Cap token 已生成');
}

async function login(page, acc = null, authPath = null) {
  const user = acc?.user || '';
  const pass = acc?.pass || '';
  const statePath = authPath || path.resolve(process.env.ACL_AUTH_STATE || 'auth-1.json');
  log(`登录 ${BASE} as ${user}`);
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  if (await loggedIn(page)) {
    log('已有会话,跳过验证码');
    return;
  }
  if (fs.existsSync(statePath)) {
    log('会话失效,重新登录');
    fs.unlinkSync(statePath);
  }
  await page.waitForSelector('cap-widget', { timeout: 30000 });
  await dismissCookieConsent(page);
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await shot(page, '01-login.png');
  let authed = false;
  for (let i = 0; i < 4 && !authed; i++) {
    try {
      await solveLoginCap(page, i);
      authed = true;
    } catch (e) {
      log(`验证码失败(${i + 1}/4): ${e.message}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await dismissCookieConsent(page);
      await page.fill('#username', user);
      await page.fill('#password', pass);
    }
  }
  if (!authed) throw new Error('验证码多次失败');
  await page.click("button[type='submit']");
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await page.context().storageState({ path: statePath });
  log(`登录成功,会话写入 ${statePath}`);
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  const diff = target - Date.now();
  if (isNaN(diff)) return null;
  if (diff <= 0) return '已到期';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const expStr = new Date(target).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${d}天${h}小时 (到期: ${expStr})`;
}

async function discover(page) {
  const servers = [];
  const seen = new Set();

  // 2026-11 改版: 免费套餐服务在订阅接口 (/api/client 现在返回空列表)
  const rSub = await api(page, '/api/client/credits/subscriptions');
  if (rSub.status === 200 && Array.isArray(rSub.data?.subscriptions)) {
    for (const s of rSub.data.subscriptions) {
      const id = String(s.service_id || s.id || '').replace(/^hosting-/, '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      servers.push({
        id,
        uuid: id,
        name: s.name || s.plan_name || id,
        expiresAt: s.expires_at || null,
        canRenew: !!s.can_renew,
        kind: s.kind || 'hosting',
      });
    }
  }

  // 兼容旧版 Pterodactyl 服务器列表
  const r = await api(page, '/api/client');
  if (r.status === 200 && Array.isArray(r.data?.data)) {
    for (const item of r.data.data) {
      if (item.object === 'server' && item.attributes) {
        const id = item.attributes.identifier;
        if (id && !seen.has(id)) {
          seen.add(id);
          servers.push({
            id,
            uuid: item.attributes.uuid,
            name: item.attributes.name || id,
            expiresAt: item.attributes.expires_at || null,
            canRenew: !!item.attributes.can_renew,
          });
        }
      }
    }
  }

  if (SERVER_ID && !seen.has(SERVER_ID)) {
    servers.push({ id: SERVER_ID, uuid: SERVER_ID, name: SERVER_ID, expiresAt: null, canRenew: false });
  }

  log(`发现服务: ${servers.map((s) => `${s.name}(${s.id.slice(0, 8)}…) 到期:${s.expiresAt || '未知'}`).join(', ') || '(无)'}`);
  return servers;
}

function classifyRenew(r) {
  if (r.status >= 200 && r.status < 300) {
    const exp = r.data?.expires_at ? ` (到期: ${r.data.expires_at})` : '';
    const msg = r.data?.message || (typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {}));
    return { ok: true, skip: false, captcha: false, text: `续期成功${exp} ${msg.slice(0, 120)}` };
  }
  const blob = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
  // 2026-11 新端点: 422 renew_too_early = 未到窗口 (到期前2天才开放)
  if (r.status === 422 && /renew_too_early/i.test(blob)) {
    return { ok: true, skip: true, captcha: false, text: '未到续期窗口 (需在到期前 2 天内)' };
  }
  // 旧端点语义: 400 renewal_not_available
  if (r.status === 400 && (r.data?.error === 'renewal_not_available' || r.data?.code === 'renewal_not_available' || /renewal_not_available/i.test(blob))) {
    return { ok: true, skip: true, captcha: false, text: `未到续期窗口 剩余 ${r.data?.days_remaining ?? r.data?.hours_remaining ?? '?'}` };
  }
  if (r.status === 403 && (/captcha/i.test(blob) || /challenge/i.test(blob) || /token/i.test(blob) || blob === '{}' || blob === '""')) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP 403 captcha_required' };
  }
  return { ok: false, skip: false, captcha: false, text: `HTTP ${r.status} ${blob.slice(0, 180)}` };
}

async function solveCapCaptcha(page) {
  log('通过平台 Cap 验证码系统求解 token...');
  return page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const endpoint = window.SiteConfiguration?.recaptcha?.apiEndpoint || 'https://cap.aclclouds.com/235a82a3e3/';
      const timer = setTimeout(() => reject(new Error('Cap 验证码计算超时 (15s)')), 15000);

      const container = document.createElement('div');
      container.id = 'cap-solver-helper';
      container.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:999999;';
      const widget = document.createElement('cap-widget');
      widget.setAttribute('data-cap-api-endpoint', endpoint);
      widget.setAttribute('data-cap-disable-haptics', 'true');

      const cleanup = () => {
        clearTimeout(timer);
        try { container.remove(); } catch {}
      };

      widget.addEventListener('solve', (e) => {
        const t = e.detail?.token || widget.token;
        cleanup();
        if (t) resolve(t);
        else reject(new Error('未获取到 Cap token'));
      });

      widget.addEventListener('error', (e) => {
        cleanup();
        reject(new Error('Cap 求解错误: ' + JSON.stringify(e.detail || {})));
      });

      container.appendChild(widget);
      document.body.appendChild(container);

      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        if (widget.token) {
          clearInterval(interval);
          cleanup();
          return resolve(widget.token);
        }
        try {
          const btn = widget.querySelector('.captcha-trigger') ||
                      widget.shadowRoot?.querySelector('.captcha-trigger') ||
                      widget.querySelector('[role="button"]') ||
                      widget.shadowRoot?.querySelector('[role="button"]');
          if (btn) btn.click();
        } catch {}
        if (checks > 20) clearInterval(interval);
      }, 300);
    });
  });
}

async function getServiceExpiry(page, id) {
  try {
    const r = await api(page, '/api/client/credits/subscriptions');
    if (r.status !== 200 || !Array.isArray(r.data?.subscriptions)) return null;
    for (const s of r.data.subscriptions) {
      const sid = String(s.service_id || s.id || '').replace(/^hosting-/, '');
      if (sid === id) return s.expires_at || null;
    }
  } catch {}
  return null;
}

async function getRenewalCaptchaToken(page) {
  try {
    const token = await solveCapCaptcha(page);
    if (token) return token;
  } catch (capErr) {
    log(`Cap 自动求解未通过: ${capErr.message}，尝试降级旧版验证码接口...`);
  }
  return solveCaptchaApi(page, 'renewal_gate');
}

async function tryRenew(page, server) {
  const id = server.id;
  const name = server.name || id;
  log(`开始检查续期: ${name} (${id})`);

  if (DRY_RUN) return { id, ok: true, skip: true, text: `[DRY_RUN] ${name} (${id}) 跳过实际提交` };

  // 1. UI 自动化续期 (优先访问服务器控制台 /server/:id)
  try {
    await page.goto(`${BASE}/server/${id}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const btnPatterns = [
      'button:has-text("Renouveler maintenant"):visible',
      'button:has-text("Renew now"):visible',
      'button:has-text("Renouveler"):visible',
      'button:has-text("Renew"):visible',
      'button:has-text("Réactiver"):visible',
      'a:has-text("Renouveler"):visible',
    ];

    let targetBtn = null;
    let matchedPat = '';
    for (const pat of btnPatterns) {
      const loc = page.locator(pat).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        targetBtn = loc;
        matchedPat = pat;
        break;
      }
    }

    if (targetBtn) {
      const beforeExpiry = server.expiresAt || (await getServiceExpiry(page, id));
      const beforeMs = beforeExpiry ? new Date(beforeExpiry).getTime() : NaN;
      log(`找到 /server/${id} UI 续期按钮 [${matchedPat}], 执行点击... (当前到期: ${beforeExpiry || '未知'})`);
      let clicked = false;
      try {
        await targetBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await targetBtn.click({ timeout: 5000 });
        clicked = true;
      } catch (clickErr) {
        log(`常规点击失败 (${clickErr.message}), 尝试 DOM 触发点击...`);
        try {
          await targetBtn.evaluate((el) => el.click());
          clicked = true;
        } catch (evalErr) {
          log(`DOM 点击失败: ${evalErr.message}`);
        }
      }

      if (clicked) {
        await page.waitForTimeout(1500);
        const modal = page.locator("[role='dialog']:visible, div[aria-labelledby='renew-captcha-title']:visible").first();
        if ((await modal.count()) > 0 && (await modal.isVisible().catch(() => false))) {
          log('检测到 Cap 验证码弹窗, 触发过盾...');
          try {
            const capTrigger = modal.locator('.captcha-trigger, [role="button"], cap-widget').first();
            if ((await capTrigger.count()) > 0) {
              await capTrigger.click().catch(() => {});
            }
            await page.waitForTimeout(5000);
          } catch (e) {
            log(`弹窗验证码处理异常: ${e.message}`);
          }
        }

        // 验证 UI 结果: 不再用页面静态文本判断 (旧文本 "Expire dans 2j" 会误报成功并跳过 API 续期),
        // 改为轮询订阅接口, 确认 expires_at 真的往后推。
        let verified = false;
        let observedExpiry = beforeExpiry;
        for (let k = 0; k < 10 && !verified; k++) {
          await page.waitForTimeout(2000);
          const nowExpiry = await getServiceExpiry(page, id);
          if (nowExpiry) observedExpiry = nowExpiry;
          const nowMs = nowExpiry ? new Date(nowExpiry).getTime() : NaN;
          if (Number.isFinite(nowMs) && Number.isFinite(beforeMs) && nowMs > beforeMs + 60 * 60 * 1000) {
            verified = true;
          }
        }
        if (verified) {
          log(`UI 续期验证成功: ${name} 到期 ${beforeExpiry || '?'} -> ${observedExpiry}`);
          return { id, ok: true, skip: false, text: `${name} (${id}): UI 续期成功 (到期: ${observedExpiry})` };
        }
        log(`UI 点击后到期时间未见后移 (当前: ${observedExpiry || '未知'}), 转入 API 续期兜底`);
      }
    } else {
      log(`未在 /server/${id} 找到可见续期按钮，直接进入 API 续期逻辑`);
    }
  } catch (uiErr) {
    log(`UI 续期交互异常: ${uiErr.message}，自动转入 API 续期`);
  }

  // 2. API 直接续期及验证码补发
  log(`尝试 API 续期接口...`);
  // 2026-11 改版: 新订阅制端点 /api/client/hosting/apps/{uuid}/renew;
  // 旧端点已 404, 若新端点 404 则回退旧路径兼容
  let renewPath = `/api/client/hosting/apps/${id}/renew`;
  let r = await api(page, renewPath, 'POST', {});
  if (r.status === 404) {
    log('新端点 404, 回退旧端点 /api/client/servers/{id}/upgrade/renew');
    renewPath = `/api/client/servers/${id}/upgrade/renew`;
    r = await api(page, renewPath, 'POST', {});
  }
  log(`API 初始响应: HTTP ${r.status} ${JSON.stringify(r.data || '')}`);
  let c = classifyRenew(r);

  if (c.captcha) {
    log(`检测到 captcha_required, 获取 renewal_gate 验证码凭据...`);
    try {
      const token = await getRenewalCaptchaToken(page);
      log(`获取到 captcha_token, 提交续期请求...`);
      r = await api(page, renewPath, 'POST', { captcha_token: token });
      log(`带 Token API 续期响应: HTTP ${r.status} ${JSON.stringify(r.data || '')}`);
      c = classifyRenew(r);
    } catch (e) {
      c = { ok: false, skip: false, captcha: false, text: `验证码求解失败: ${e.message}` };
    }
  }

  // 续期后校验: 回读订阅接口, 确认 200 之后到期时间真的往后推
  let verifiedExpiry = null;
  if (c.ok && !c.skip) {
    const beforeMs = server.expiresAt ? new Date(server.expiresAt).getTime() : NaN;
    await page.waitForTimeout(3000);
    const afterExpiry = await getServiceExpiry(page, id);
    const afterMs = afterExpiry ? new Date(afterExpiry).getTime() : NaN;
    if (Number.isFinite(afterMs) && Number.isFinite(beforeMs) && afterMs > beforeMs + 60 * 60 * 1000) {
      verifiedExpiry = afterExpiry;
      log(`续期校验通过: ${name} 到期 ${server.expiresAt} -> ${afterExpiry}`);
    } else {
      log(`续期 API 返回成功, 但到期时间未确认后移 (before=${server.expiresAt || '未知'} after=${afterExpiry || '未读到'})`);
    }
  }

  let resultText = `${name} (${id}): ${c.text}`;
  if (verifiedExpiry) resultText += ` (到期: ${verifiedExpiry})`;
  const exactRemaining = formatRemaining(server.expiresAt);
  if (c.skip && exactRemaining) {
    resultText = `${name} (${id}): 未到续期窗口，剩余 ${exactRemaining}`;
  }

  log(`API 续期最终结果: ${resultText}`);
  return { id, ok: c.ok, skip: c.skip, text: resultText };
}

function resolveExecutablePath() {
  const paths = [
    process.env.CHROME_PATH,
    'D:\\PlaywrightBrowsers\\chromium-1217\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function maskUser(u) {
  return String(u).replace(/^(.{2}).*?(@.*)$/, '$1****$2');
}

async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) {
    throw new Error('未配置任何账号: 请设置 ACL_USERNAME/ACL_PASSWORD (或 EMAIL/EMAIL_2 / ACL_ACCOUNTS)');
  }
  log(`共加载 ${accounts.length} 个账号: ${accounts.map((a) => maskUser(a.user)).join(', ')}`);
  const execPath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(execPath ? { executablePath: execPath } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  const results = [];
  let failed = false;
  let anyRenewed = false;

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const label = `账号${i + 1}(${maskUser(acc.user)})`;
    const authPath = process.env.ACL_AUTH_STATE
      ? `${process.env.ACL_AUTH_STATE}.${i + 1}`
      : path.resolve(`auth-${i + 1}.json`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: fs.existsSync(authPath) ? authPath : undefined,
    });
    const page = await context.newPage();
    log(`======== 开始处理 ${label} ========`);
    try {
      await login(page, acc, authPath);
      await shot(page, `03-dashboard-${i + 1}.png`);

      const servers = await discover(page);
      await shot(page, `04-projects-${i + 1}.png`);

      if (!servers.length) {
        failed = true;
        results.push({ ok: false, skip: false, text: `${label}: 账号下未发现任何服务` });
        continue;
      }

      for (const server of servers) {
        const res = await tryRenew(page, server);
        results.push({ ...res, text: `${label} ${res.text}` });
        if (res.ok && !res.skip) anyRenewed = true;
        if (!res.ok) failed = true;
      }
    } catch (e) {
      failed = true;
      results.push({ ok: false, skip: false, text: `${label}: 执行失败 - ${e.message}` });
      log(`${label} 执行失败: ${e.message}`);
      try { await shot(page, `99-error-${i + 1}.png`); } catch {}
    } finally {
      await context.close().catch(() => {});
    }
  }
  await browser.close().catch(() => {});

  const summary = results.length ? results.map((r) => r.text).join('\n') : '未找到可续期服务';
  log(summary);

  // 截图仅限续期完成和执行失败
  let photoToSend = null;
  const errPics = shots.filter((f) => f.includes('99-error'));
  const donePics = shots.filter((f) => f.includes('06-result'));
  if (failed) {
    if (errPics.length && fs.existsSync(errPics[errPics.length - 1])) photoToSend = errPics[errPics.length - 1];
  } else if (anyRenewed) {
    if (donePics.length && fs.existsSync(donePics[donePics.length - 1])) photoToSend = donePics[donePics.length - 1];
  }

  const tgMessage = formatTgMessage({
    failed,
    results,
    errorMsg: failed && !results.length ? summary : '',
  });

  await tg(tgMessage, { photo: photoToSend });
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    const failPic = path.join(SHOT, '99-error.png');
    const tgMessage = formatTgMessage({
      failed: true,
      results: [],
      errorMsg: e.message,
    });
    await tg(tgMessage, { photo: fs.existsSync(failPic) ? failPic : null });
    process.exit(1);
  });
}

export { score, ocrScore, classifyRenew };
