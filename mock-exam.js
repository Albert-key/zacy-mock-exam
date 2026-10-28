#!/usr/bin/env node
/**
 * 朝这儿练（www.zacy.top）全真模拟自动答题脚本
 *
 * 用法：
 *   node mock-exam.js                 启动后按提示输入考号、密码
 *   node mock-exam.js --min-minutes 40 --no-shot
 *   node mock-exam.js --user 你的考号 --pass '你的密码'   （非交互，便于定时任务）
 *
 * 流程：登录 → 找当天「全真模拟」→ 取题 → 作答（题库优先）→ 心跳凑满最短时长
 *      → 交卷 → 等待 AI 批阅 → 学回标准答案 → 无头浏览器截图结果页
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const HOST = 'www.zacy.top';
const DIR = __dirname;
const BANK_FILE = path.join(DIR, 'answer-bank.json');

// ---------------------------------------------------------------- 命令行参数
function parseArgs(argv) {
  const opts = {
    user: null,
    pass: null,
    minMinutes: 40,
    out: path.join(DIR, 'shots'),
    shot: true,
    dryRun: false,
    match: '全真模拟',
    examId: null,
    bank: BANK_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--user': opts.user = next(); break;
      case '--pass': opts.pass = next(); break;
      case '--min-minutes': opts.minMinutes = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--match': opts.match = next(); break;
      case '--exam': opts.examId = Number(next()); break;
      case '--bank': opts.bank = next(); break;
      case '--no-shot': opts.shot = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        break;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
朝这儿练 · 全真模拟自动答题

  node mock-exam.js [选项]

选项
  --user <考号>        考号（不填则启动时提示输入）
  --pass <密码>        密码（不填则启动时隐藏输入）
  --min-minutes <n>    最短答题时长，默认 40 分钟
  --exam <id>          指定考试 id（默认自动选当天「全真模拟」）
  --match <关键字>     考试标题匹配关键字，默认「全真模拟」
  --bank <file>        题库文件，默认 answer-bank.json
  --out <dir>          截图输出目录，默认 ./shots
  --no-shot            交卷后不截图
  --dry-run            只登录并列出可用考试，不开始答题
`);
}

// ---------------------------------------------------------------- 基础工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

function promptLine(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function promptHidden(query) {
  if (!process.stdin.isTTY) return promptLine(query);
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n已取消\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------- HTTP 客户端
function request(method, apiPath, body, token, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = https.request({ host: HOST, path: apiPath, method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class Api {
  constructor() {
    this.token = null;
  }
  async call(method, p, body) {
    const r = await request(method, p, body, this.token);
    if (r.json && typeof r.json.code === 'number' && r.json.code !== 200) {
      const err = new Error(r.json.message || `接口错误 ${r.json.code}`);
      err.code = r.json.code;
      err.data = r.json.data;
      throw err;
    }
    if (!r.json) {
      const err = new Error(`接口返回异常（HTTP ${r.status}）`);
      err.code = -1;
      throw err;
    }
    return r.json.data;
  }
  get(p) { return this.call('GET', p); }
  post(p, body = {}) { return this.call('POST', p, body); }
}

// ---------------------------------------------------------------- 登录（含验证码）
function openFile(file) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

async function login(api, examNo, password) {
  let captcha = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const body = { exam_no: examNo, password };
    if (captcha) {
      body.captcha_id = captcha.id;
      body.captcha_code = captcha.code;
    }
    const r = await request('POST', '/api/login', body, null);
    const j = r.json || {};
    if (j.code === 200 && j.data && j.data.token) {
      api.token = j.data.token;
      log(`登录成功：${j.data.user.exam_no}`);
      return j.data.user;
    }
    const needCaptcha = j.data && j.data.need_captcha === true;
    if (!needCaptcha) throw new Error(j.message || '登录失败');
    if (attempt === 6) throw new Error('登录失败：验证码多次未通过');

    // 取验证码
    const c = await request('GET', '/api/captcha', undefined, null);
    const d = c.json && c.json.data;
    if (!d || !d.image_base64) throw new Error('获取验证码失败');
    const file = path.join(os.tmpdir(), `zacy-captcha-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(d.image_base64, 'base64'));
    log('需要图形验证码，已保存并打开：' + file);
    openFile(file);
    const code = await promptLine('请输入验证码：');
    captcha = { id: d.captcha_id, code: code.trim() };
    log(j.message || '验证码校验，重试中…');
  }
  throw new Error('登录失败');
}

// ---------------------------------------------------------------- 考试选择
async function listExams(api) {
  const data = await api.get('/api/user/daily-exams');
  return Array.isArray(data) ? data : [];
}

async function pickExam(api, opts) {
  const exams = await listExams(api);
  log(`今日可用考试：${exams.length} 场`);
  for (const e of exams) {
    log(
      `  · id=${e.id} 《${e.title}》 ${e.question_count || ''}题 ` +
      `${e.start_time}-${e.end_time} ${e.can_enter ? '可进入' : '不可进入'}`
    );
  }
  if (opts.examId) {
    const hit = exams.find((e) => e.id === opts.examId);
    if (!hit) throw new Error(`未找到考试 id=${opts.examId}`);
    return hit;
  }
  const candidates = exams.filter(
    (e) => e.can_enter && (!opts.match || (e.title || '').includes(opts.match))
  );
  if (!candidates.length) throw new Error(`没有可进入的「${opts.match}」考试`);
  if (candidates.length === 1) return candidates[0];

  // 多场时优先当天
  const today = new Date().toISOString().slice(0, 10);
  const todayHit = candidates.filter((e) => (e.exam_date || '').startsWith(today));
  const pool = todayHit.length ? todayHit : candidates;
  if (pool.length === 1) return pool[0];

  console.log('检测到多场可答考试，请选择：');
  pool.forEach((e, i) => console.log(`  ${i + 1}. 《${e.title}》 ${e.question_count || ''}题`));
  const ans = Number(await promptLine('输入序号：'));
  return pool[Math.max(0, Math.min(pool.length - 1, ans - 1))];
}

async function findInProgress(api, examId) {
  try {
    const data = await api.get('/api/user/exam-records?page=1&page_size=100');
    const list = (data && data.list) || [];
    const hit = list.find((r) => r.exam_id === examId && r.status === 'in_progress');
    return hit || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 答案构造
function loadBank(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.questions ? j : { questions: {} };
  } catch {
    return { questions: {} };
  }
}

function saveBank(file, bank) {
  bank.updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(bank, null, 2), 'utf8');
}

const LETTERS = 'ABCDEFGHIJ';

function optionCount(q) {
  return Array.isArray(q.options) ? q.options.length : 4;
}

function cleanObjective(answer, q) {
  const letters = String(answer || '')
    .toUpperCase()
    .replace(/[^A-J]/g, '')
    .split('');
  const uniq = [...new Set(letters)].filter((l) => LETTERS.indexOf(l) < optionCount(q));
  uniq.sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b));
  return uniq.join(',');
}

function heuristicAnswer(q) {
  const n = optionCount(q);
  switch (q.type) {
    case 'single_choice':
      return 'A';
    case 'true_false':
      return 'A';
    case 'multi_choice':
    case 'indefinite_choice': {
      const count = n >= 4 ? 3 : Math.max(2, n);
      return LETTERS.slice(0, count).split('').join(',');
    }
    case 'case_analysis':
      return [
        '1. 行为定性：结合行为人主观故意、客观行为及因果关系，本案涉嫌相应犯罪，应依照刑法规定准确定性。',
        '2. 共同犯罪：各行为人具有共同故意与分工配合，构成共同犯罪；起组织、策划、指挥或者主要作用者为主犯，起次要、辅助作用者为从犯，对从犯应当从轻、减轻处罚或者免除处罚。',
        '3. 责任年龄与能力：已满十六周岁的人犯罪应当负刑事责任；已满十四周岁不满十六周岁的人仅对刑法第十七条第二款规定的八类严重犯罪负责；不满十八周岁的，应当从轻或者减轻处罚。',
        '4. 量刑情节：具有自首、坦白、认罪认罚、退赃退赔、取得被害人谅解等情节的，可以依法从宽处理。',
        '5. 程序问题：办理案件应当严格遵守立案、侦查、强制措施、证据收集等法定程序，排除非法证据。',
      ].join('\n');
    case 'short_answer':
      return [
        '第一，坚持党的领导，把相关工作纳入法治轨道，依法应对、依法处置。',
        '第二，坚持以人民为中心，区分矛盾性质，优先解决群众合理诉求，慎用强制措施。',
        '第三，坚持严格执法，对违法犯罪行为依法果断处置，维护法律权威。',
        '第四，坚持规范执法，严格履行法定程序，做到全程记录、证据固定、裁量适当。',
        '第五，坚持公正执法，平等对待各方当事人，依法保障其陈述、申辩等权利。',
        '第六，坚持文明执法，规范执法用语和行为，加强监督问责与执法权益保障。',
      ].join('\n');
    default:
      return '';
  }
}

function buildAnswers(questions, bank) {
  const answers = {};
  let fromBank = 0;
  for (const q of questions) {
    const hit = bank.questions[String(q.id)];
    let value = '';
    if (hit && hit.answer) {
      value = hit.answer;
      fromBank++;
    } else {
      value = heuristicAnswer(q);
    }
    if (q.type === 'single_choice' || q.type === 'multi_choice' ||
        q.type === 'indefinite_choice' || q.type === 'true_false') {
      const cleaned = cleanObjective(value, q);
      answers[q.id] = cleaned || heuristicAnswer(q);
    } else {
      answers[q.id] = String(value || '').trim() || heuristicAnswer(q);
    }
  }
  return { answers, fromBank };
}

// ---------------------------------------------------------------- 计时交卷
async function answerAndSubmit(api, exam, questions, answers, minMinutes) {
  const minSec = Math.max(0, Math.round(minMinutes * 60));
  const record = await findInProgress(api, exam.id);
  const startEpoch = record ? new Date(record.start_time + '+08:00').getTime() : Date.now();
  if (record) log(`检测到进行中的作答记录 #${record.id}，从 ${record.start_time} 继续计时`);
  else log('开始新的作答');

  const hardLimit = Math.max(minSec + 120, (exam.duration_minutes || 150) * 60 - 90);
  let accumulated = record ? record.accumulated_seconds || 0 : 0;
  let lastSave = 0;
  let lastPrint = 0;

  for (;;) {
    try {
      const hb = await api.post(`/api/user/daily-exams/${exam.id}/heartbeat`);
      if (hb && typeof hb.accumulated_seconds === 'number') accumulated = hb.accumulated_seconds;
    } catch (e) {
      if (e.code === 49001) {
        log('服务端判定切屏超限并自动交卷，停止作答');
        break;
      }
      log('心跳失败：' + e.message);
    }

    const wall = Math.round((Date.now() - startEpoch) / 1000);
    const mins = (s) => (s / 60).toFixed(0);
    if (Date.now() - lastPrint > 55000) {
      log(`答题中：已用时 ${mins(wall)} 分，服务端累计 ${mins(accumulated)} 分 / 目标 ${minMinutes} 分`);
      lastPrint = Date.now();
    }
    if (accumulated >= minSec && wall >= minSec) break;
    if (wall >= hardLimit) {
      log('接近考试时限，提前交卷');
      break;
    }
    if (Date.now() - lastSave > 300000) {
      try {
        await api.post(`/api/user/daily-exams/${exam.id}/save-progress`, { answers: JSON.stringify(answers) });
        lastSave = Date.now();
      } catch {}
    }
    await sleep(15000);
  }

  // 交卷
  const duration = Math.round((Date.now() - startEpoch) / 1000);
  let result;
  try {
    result = await api.post(`/api/user/daily-exams/${exam.id}/submit`, {
      answers: JSON.stringify(answers),
      duration_seconds: duration,
    });
    log(`交卷成功：客观题 ${result.correct_count}/${result.total_questions}，得分 ${result.score}` +
      (result.need_grading ? '（主观题 AI 批阅中）' : ''));
  } catch (e) {
    log('交卷返回：' + e.message + '（可能已自动交卷，继续查询结果）');
  }
  return { result, duration, startEpoch };
}

// ---------------------------------------------------------------- 批阅与学习
async function waitGrading(api, examId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let record = null;
  while (Date.now() < deadline) {
    try {
      const data = await api.get(`/api/user/exam-records?page=1&page_size=20`);
      const list = (data && data.list) || [];
      const hit = list.find((r) => r.exam_id === examId && r.id);
      if (hit) record = hit;
      if (hit && hit.status === 'submitted') {
        // 用详情判断是否已有标准答案
        try {
          const detail = await api.get(`/api/user/exam-records/${hit.id}`);
          if (detail && Array.isArray(detail.questions) && detail.questions.some((q) => q.answer)) {
            return detail;
          }
        } catch {}
      }
    } catch {}
    await sleep(15000);
  }
  return record;
}

function learnFromRecord(record, bank) {
  if (!record || !Array.isArray(record.questions)) return 0;
  let learned = 0;
  for (const q of record.questions) {
    if (q.answer && String(q.answer).trim()) {
      const prev = bank.questions[String(q.id)];
      const answer = q.type === 'single_choice' || q.type === 'multi_choice' ||
        q.type === 'indefinite_choice' || q.type === 'true_false'
        ? cleanObjective(q.answer, q)
        : String(q.answer).trim();
      if (!prev || prev.answer !== answer) learned++;
      bank.questions[String(q.id)] = { type: q.type, answer };
    }
  }
  return learned;
}

// ---------------------------------------------------------------- 截图
function findChrome() {
  const local = process.env.LOCALAPPDATA || '';
  const cands = [
    process.env.CHROME_PATH,
    path.join(local, 'zacy-mock-exam\\chrome\\chrome-headless-shell.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of cands) if (p && fs.existsSync(p)) return p;
  return null;
}

function httpJson(port, method, p) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP 连接失败'));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时 ' + method));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常');
    return r.result && r.result.value;
  }
}

async function captureResult({ token, user, title, outFile, chromePath }) {
  const port = 9300 + Math.floor(Math.random() * 300);
  const profile = path.join(os.tmpdir(), 'zacy-chrome-' + Date.now());
  // chrome-headless-shell 本身就是无头模式，不能再传 --headless=new
  const isHeadlessShell = /chrome-headless-shell/i.test(chromePath);
  const chrome = spawn(chromePath, [
    ...(isHeadlessShell ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-extensions',
    '--window-size=430,932',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        targets = await httpJson(port, 'GET', '/json/list');
        if (Array.isArray(targets) && targets.length) break;
      } catch {}
    }
    if (!Array.isArray(targets)) throw new Error('浏览器启动失败');
    const page = targets.find((t) => t.type === 'page');
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
    });

    await cdp.send('Page.navigate', { url: 'https://' + HOST + '/login' });
    await sleep(4500);
    const userInfo = JSON.stringify({
      id: user.id, exam_no: user.exam_no, nickname: user.nickname,
      openid: user.openid, password: user.password, must_change_password: false,
    });
    await cdp.eval(
      `localStorage.setItem('user_token', ${JSON.stringify(token)});` +
      `localStorage.setItem('userInfo', ${JSON.stringify(userInfo)});` +
      `localStorage.setItem('_splash_done','1'); 'ok'`
    );

    await cdp.send('Page.navigate', { url: 'https://' + HOST + '/records/exam' });
    await sleep(8000);

    const expr = `(() => {
      const items = [...document.querySelectorAll('.ant-list-item')];
      const el = items.find(e => e.innerText.includes(${JSON.stringify(title)}));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'CLICKED';
    })()`;
    const clicked = await cdp.eval(expr);
    if (clicked !== 'CLICKED') throw new Error('未找到成绩记录行');
    await sleep(4000);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
    await cdp.send('Browser.close').catch(() => {});
    return outFile;
  } finally {
    try { chrome.kill(); } catch {}
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (opts.shot && nodeMajor < 22) {
    console.log(`[提示] 当前 Node ${process.versions.node} 低于 22，内置 WebSocket 不可用，本次自动跳过截图。`);
    opts.shot = false;
  }
  const api = new Api();

  console.log('==== 朝这儿练 · 全真模拟自动答题 ====');
  const examNo = opts.user || (await promptLine('考号：'));
  if (!examNo) throw new Error('考号不能为空');
  const password = opts.pass || (await promptHidden('密码：'));
  if (!password) throw new Error('密码不能为空');

  const user = await login(api, examNo, password);
  const exam = await pickExam(api, opts);
  log(`选中考试：《${exam.title}》（id=${exam.id}，${exam.question_count || '?'} 题，限时 ${exam.duration_minutes} 分钟）`);
  if (opts.dryRun) {
    log('--dry-run：仅检查登录与考试列表，不进入答题');
    return;
  }

  // 取题（同时会创建/恢复作答记录）
  let questionData;
  try {
    questionData = await api.get(`/api/user/daily-exams/${exam.id}/questions`);
  } catch (e) {
    throw new Error('取题失败：' + e.message);
  }
  const questions = (questionData && questionData.questions) || [];
  if (!questions.length) throw new Error('该考试没有题目');
  const types = questions.reduce((m, q) => ((m[q.type] = (m[q.type] || 0) + 1), m), {});
  log(`题目构成：${Object.entries(types).map(([k, v]) => `${k}×${v}`).join('，')}`);

  // 组答案
  const bank = loadBank(opts.bank);
  const { answers, fromBank } = buildAnswers(questions, bank);
  log(`已组答案：题库命中 ${fromBank} 题，其余按题型规则作答`);

  // 计时 + 交卷
  const { duration } = await answerAndSubmit(api, exam, questions, answers, opts.minMinutes);

  // 等待批阅并学习答案
  log('等待批阅结果…');
  const record = await waitGrading(api, exam.id, 240000);
  let learned = 0;
  if (record) {
    learned = learnFromRecord(record, bank);
    saveBank(opts.bank, bank);
    if (record.score != null) {
      log(`批阅完成：${record.score} 分（客观题 ${record.correct_count}/${record.total_questions} 正确）`);
    }
  }
  log(`题库已更新：新增/修正 ${learned} 题（累计 ${Object.keys(bank.questions).length} 题）`);

  // 截图
  if (opts.shot) {
    const chromePath = findChrome();
    if (!chromePath) {
      log('未找到 Chrome/Edge，跳过截图（可用 --no-shot 关闭该提示）');
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outFile = path.join(opts.out, `全真模拟-${exam.title}-${stamp}.png`);
      try {
        await captureResult({ token: api.token, user, title: exam.title, outFile, chromePath });
        log('成绩截图：' + outFile);
      } catch (e) {
        log('截图失败：' + e.message);
      }
    }
  }

  log(`完成，用时 ${(duration / 60).toFixed(1)} 分钟`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n[错误] ' + e.message);
    process.exit(1);
  });
}

module.exports = {
  Api,
  request,
  login,
  listExams,
  pickExam,
  loadBank,
  saveBank,
  buildAnswers,
  cleanObjective,
  heuristicAnswer,
  learnFromRecord,
  findChrome,
  captureResult,
};
