const TOKEN_KEY = 'agent-token';
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  history.replaceState(null, '', location.pathname);
}
let token = localStorage.getItem(TOKEN_KEY) ?? '';

const $ = (id) => document.getElementById(id);
const statusBadge = $('status-badge');
const chat = $('chat');
const taskList = $('task-list');

let status = 'idle';
let currentTaskId = undefined;
let pendingPlanSummary = undefined;
let pendingConfirmRequest = undefined;
let planBubble = undefined;
let confirmBubble = undefined;
let decisionRef = undefined;
let planTotal = 0;
let completedSteps = 0;
let lastVerificationFailed = false;

function setTokenError(message) {
  $('token-error').textContent = message ?? '';
}

function showTokenBar(message) {
  setTokenError(message ?? '');
  $('token-bar').classList.remove('hidden');
}

async function api(path, options = {}) {
  const headers = { 'x-agent-token': token, ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  if (response.status === 403) {
    showTokenBar('Token 无效或缺失，请重新输入');
    throw new Error('unauthorized');
  }
  return response;
}

async function apiJson(path, options = {}) {
  const response = await api(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

function setStatus(value) {
  status = value;
  statusBadge.textContent = value;
  statusBadge.className = `badge status-${value}`;
  $('abort-btn').classList.toggle(
    'hidden',
    value !== 'running' && value !== 'awaiting_plan' && value !== 'awaiting_confirm',
  );
  $('run-btn').disabled = value !== 'idle' && value !== 'finished';
}

function formatTime(ts) {
  return new Date(ts ?? Date.now()).toTimeString().slice(0, 8);
}

function addBubble(role, kind, title, detail, options = {}) {
  const msg = document.createElement('div');
  msg.className = `msg msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className = `bubble kind-${kind}`;

  const head = document.createElement('div');
  head.className = 'bubble-head';
  head.innerHTML = `<span class="time">${formatTime()}</span><span class="title">${escapeHtml(title)}</span>`;
  bubble.appendChild(head);

  if (detail !== undefined && detail !== null && detail !== '') {
    if (options.collapsible) {
      const details = document.createElement('details');
      details.className = 'bubble-details';
      const summary = document.createElement('summary');
      summary.textContent = options.summaryText ?? '详情';
      const body = document.createElement('pre');
      body.textContent = String(detail).slice(0, 2000);
      details.append(summary, body);
      bubble.appendChild(details);
    } else {
      const body = document.createElement('pre');
      body.className = 'bubble-body';
      body.textContent = String(detail).slice(0, 2000);
      bubble.appendChild(body);
    }
  }

  msg.appendChild(bubble);
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function describeToolResult(result) {
  if (result?.ok) {
    const preview = typeof result.content === 'string' ? result.content.slice(0, 400) : '';
    return preview ? `ok\n${preview}` : 'ok';
  }
  return `error: ${result?.error ?? 'unknown'}`;
}

function describeVerification(result) {
  const exit =
    result?.exitCode === null || result?.exitCode === undefined ? 'n/a' : result.exitCode;
  return `${result?.status ?? 'unknown'} (attempt=${result?.attempt ?? '?'}, exit=${exit}, ${result?.durationMs ?? '?'}ms)`;
}

function describeDiff(diff) {
  if (!diff) {
    return '';
  }
  if (!diff.available) {
    return `diff 不可用 (${diff.reason ?? 'unknown'})`;
  }
  return `diff: ${diff.files?.length ?? 0} 文件, +${diff.totalInsertions ?? 0} -${diff.totalDeletions ?? 0}`;
}

function renderPlan(plan) {
  const lines = (plan?.steps ?? [])
    .map((step, index) => `${index + 1}. [${step.id}] ${step.title} — ${step.description ?? ''}`)
    .join('\n');
  return `${plan?.goal ?? ''}\n${lines}${plan?.notes ? `\n备注: ${plan.notes}` : ''}`;
}

function clearDecisionRef() {
  if (decisionRef) {
    for (const button of decisionRef.buttons) {
      button.disabled = true;
    }
    decisionRef = undefined;
  }
}

function noteDecision(bubble, approved, label) {
  if (bubble.querySelector('.decision-note')) {
    return;
  }
  for (const button of bubble.querySelectorAll('.decision-buttons button')) {
    button.disabled = true;
  }
  const note = document.createElement('div');
  note.className = 'decision-note';
  note.textContent = label ?? (approved ? '✓ 已批准' : '✗ 已拒绝');
  bubble.appendChild(note);
}

function attachDecisionButtons(bubble, kind) {
  if (decisionRef?.kind === kind) {
    return;
  }
  const row = document.createElement('div');
  row.className = 'decision-buttons';
  const approve = document.createElement('button');
  approve.textContent = kind === 'plan' ? '批准计划' : '批准执行';
  approve.addEventListener('click', () => decide(kind, true));
  const reject = document.createElement('button');
  reject.textContent = '拒绝';
  reject.className = 'danger';
  reject.addEventListener('click', () => decide(kind, false));
  row.append(approve, reject);
  bubble.appendChild(row);
  decisionRef = { kind, bubble, buttons: [approve, reject] };
}

function showDecision() {
  if (status !== 'awaiting_plan' && status !== 'awaiting_confirm') {
    clearDecisionRef();
    return;
  }
  if (status === 'awaiting_plan' && pendingPlanSummary) {
    const bubble = planBubble ?? addBubble('agent', 'plan', 'Plan 待确认', pendingPlanSummary);
    attachDecisionButtons(bubble, 'plan');
  }
  if (status === 'awaiting_confirm' && pendingConfirmRequest) {
    const bubble =
      confirmBubble ??
      addBubble('agent', 'confirm', '高风险操作待确认', pendingConfirmRequest.summary);
    attachDecisionButtons(bubble, 'confirm');
  }
}

async function decide(kind, approved) {
  const ref = decisionRef;
  try {
    await apiJson(kind === 'plan' ? '/api/plan' : '/api/confirm', {
      method: 'POST',
      body: JSON.stringify({ approved }),
    });
    if (ref) {
      noteDecision(ref.bubble, approved);
    }
  } catch (error) {
    if (error.message !== 'unauthorized') {
      addBubble('agent', 'error', '决策失败', error.message);
    }
  }
}

function handleEvent(type, data) {
  switch (type) {
    case 'snapshot': {
      chat.innerHTML = '';
      planBubble = undefined;
      confirmBubble = undefined;
      decisionRef = undefined;
      planTotal = 0;
      completedSteps = 0;
      lastVerificationFailed = false;
      for (const event of data.events ?? []) {
        handleEvent(event.type, event.data);
      }
      break;
    }
    case 'session_status': {
      setStatus(data.status);
      break;
    }
    case 'banner':
      addBubble('agent', 'info', '任务启动', (data.lines ?? []).join('\n'), { collapsible: true });
      break;
    case 'task_created': {
      currentTaskId = data.taskId;
      addBubble('agent', 'info', `任务已创建 ${data.taskId}`, '');
      break;
    }
    case 'plan': {
      pendingPlanSummary = renderPlan(data);
      planTotal = (data.steps ?? []).length;
      planBubble = addBubble('agent', 'plan', 'Plan 已生成', pendingPlanSummary);
      break;
    }
    case 'step_start':
      if (typeof data.total === 'number') {
        planTotal = data.total;
      }
      addBubble(
        'agent',
        'step',
        `步骤 ${data.index + 1}/${data.total}: ${data.step?.title ?? ''}`,
        '',
      );
      break;
    case 'step_end':
      if (data.result?.status === 'completed' && typeof data.index === 'number') {
        completedSteps = Math.max(completedSteps, data.index + 1);
      }
      addBubble(
        'agent',
        data.result?.status === 'completed' ? 'ok' : 'error',
        `步骤 ${data.index + 1} ${data.result?.status}`,
        data.result?.answer?.slice(0, 500),
        { collapsible: true },
      );
      break;
    case 'tool_call':
      addBubble('agent', 'tool', `→ ${data.call?.name}`, data.call?.arguments, {
        collapsible: true,
        summaryText: '参数',
      });
      break;
    case 'tool_result':
      addBubble(
        'agent',
        data.result?.ok ? 'ok' : 'error',
        `← ${data.result?.ok ? 'ok' : 'failed'} (${data.durationMs ?? '?'}ms)`,
        describeToolResult(data.result),
        { collapsible: true, summaryText: '结果' },
      );
      break;
    case 'verification': {
      const failed = data.status === 'failed';
      lastVerificationFailed = failed;
      const detail = describeVerification(data);
      if (failed && data.output) {
        const tail = String(data.output).slice(-1500);
        addBubble(
          'agent',
          'error',
          `验证 ${data.status}${data.reason ? ` — ${data.reason}` : ''}`,
          `${detail}\n\n${tail}`,
          { collapsible: true, summaryText: '验证失败详情（含输出尾部）' },
        );
      } else {
        addBubble(
          'agent',
          failed ? 'error' : data.status === 'passed' ? 'ok' : 'info',
          `验证 ${data.status}`,
          detail,
        );
      }
      break;
    }
    case 'diff':
      addBubble('agent', 'info', describeDiff(data), '');
      break;
    case 'repair':
      addBubble(
        'agent',
        data.outcome?.repaired ? 'ok' : 'error',
        `自动修复 attempt=${data.outcome?.attempt ?? '?'}/${data.maxAttempts ?? '?'}`,
        data.outcome?.summary,
        { collapsible: true },
      );
      break;
    case 'task_state':
      addBubble(
        'agent',
        data.state === 'step_failed' || data.state === 'failed' ? 'error' : 'info',
        `任务状态: ${data.state} (${data.taskId ?? ''})`,
        '',
      );
      refreshTasks();
      break;
    case 'confirm_request':
      pendingConfirmRequest = data;
      confirmBubble = addBubble('agent', 'confirm', '高风险操作待确认', data.summary);
      break;
    case 'confirm_timeout': {
      const seconds = Math.max(1, Math.round((data.timeoutMs ?? 0) / 1000));
      addBubble(
        'agent',
        'error',
        `确认超时（${seconds}s 未响应，已自动拒绝）`,
        pendingConfirmRequest?.summary ?? '',
      );
      if (confirmBubble) {
        noteDecision(confirmBubble, false, '✗ 超时自动拒绝');
      }
      clearDecisionRef();
      confirmBubble = undefined;
      pendingConfirmRequest = undefined;
      break;
    }
    case 'context_trim':
      addBubble(
        'agent',
        'info',
        `上下文: 预算 ${data.budgetTokens} tokens, 裁剪 ${data.droppedMessages ?? 0} 条消息, 截断 ${data.truncatedToolMessages ?? 0} 条工具输出`,
        '',
      );
      break;
    case 'answer':
      addBubble('agent', 'answer', '最终回答', data.content);
      break;
    case 'session_done': {
      currentTaskId = data.taskId ?? currentTaskId;
      const verificationFailed =
        planTotal > 0 && completedSteps >= planTotal && lastVerificationFailed;
      if (data.error) {
        if (verificationFailed) {
          addBubble(
            'agent',
            'error',
            '任务未通过：步骤已完成，但验证失败',
            `${data.error}\n\n展开左侧任务历史可查看验证输出尾部。`,
          );
        } else {
          addBubble('agent', 'error', '任务失败', data.error);
        }
      } else {
        addBubble('agent', 'ok', '任务结束', '');
      }
      clearDecisionRef();
      pendingConfirmRequest = undefined;
      pendingPlanSummary = undefined;
      refreshTasks();
      break;
    }
    default:
      addBubble('agent', 'info', type, JSON.stringify(data)?.slice(0, 300), { collapsible: true });
  }
  showDecision();
}

async function streamEvents() {
  while (true) {
    try {
      const response = await api('/api/events');
      if (!response.ok || response.body === null) {
        throw new Error(`SSE 连接失败 (HTTP ${response.status})`);
      }
      $('token-bar').classList.add('hidden');
      setTokenError('');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';
      let dataLines = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          } else if (line === '' && eventName) {
            try {
              handleEvent(eventName, dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : {});
            } catch (error) {
              console.error('bad event', eventName, error);
            }
            eventName = '';
            dataLines = [];
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
    } catch (error) {
      if (error.message === 'unauthorized') {
        return;
      }
    }
    setStatus(status);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function taskRow(summary) {
  const item = document.createElement('div');
  item.className = 'task-item';
  if (summary.id === currentTaskId) {
    item.classList.add('active');
  }
  item.innerHTML = `
    <div class="task-head">
      <span class="dot status-${summary.status}"></span>
      <span class="task-goal" title="${escapeHtml(summary.goal)}">${escapeHtml(summary.goal)}</span>
      <span class="task-time">${new Date(summary.updatedAt).toLocaleTimeString()}</span>
    </div>
    <div class="task-accordion hidden"></div>`;
  item.querySelector('.task-head').addEventListener('click', () => toggleAccordion(item, summary));
  return item;
}

async function refreshTasks() {
  try {
    const body = await apiJson('/api/tasks?limit=20');
    taskList.innerHTML = '';
    if (body.tasks.length === 0) {
      taskList.textContent = '（空）';
      return;
    }
    for (const summary of body.tasks) {
      taskList.appendChild(taskRow(summary));
    }
  } catch {
    taskList.textContent = '加载失败';
  }
}

function renderAccordionBody(task) {
  const steps = (task.steps ?? [])
    .map((step) => `[${step.status}] ${step.step?.title ?? ''} (tools=${step.toolCalls})`)
    .join('\n');
  const verifications = (task.verifications ?? [])
    .map((v, index) => {
      const lines = [`${index + 1}. ${describeVerification(v)}`];
      if (v.reason) {
        lines.push(`   reason: ${v.reason}`);
      }
      if (v.status !== 'passed' && v.output) {
        const tail = String(v.output).slice(-1500).replaceAll('\n', '\n   ');
        lines.push(`   output:\n   ${tail}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  const diffs = (task.diffs ?? []).map((d) => describeDiff(d)).join('\n');
  return `
    <p><span class="badge status-${task.status}">${task.status}</span> ${escapeHtml(task.goal)}</p>
    <p class="task-meta">id: ${task.id} · 创建 ${new Date(task.createdAt).toLocaleString()} · 修复 ${task.repairAttempts} 次${task.error ? ` · 错误: ${escapeHtml(task.error)}` : ''}</p>
    <pre class="accordion-body">${escapeHtml(steps || '(无步骤)')}</pre>
    <h4>验证</h4>
    <pre class="accordion-body">${escapeHtml(verifications || '(无)')}</pre>
    <h4>差异</h4>
    <pre class="accordion-body">${escapeHtml(diffs || '(无)')}</pre>`;
}

async function toggleAccordion(item, summary) {
  const accordion = item.querySelector('.task-accordion');
  if (!accordion) {
    return;
  }
  const isCollapsed = accordion.classList.contains('hidden');
  if (isCollapsed) {
    accordion.classList.remove('hidden');
    item.classList.add('open');
    if (accordion.dataset.loaded === 'true') {
      return;
    }
    accordion.textContent = '加载中…';
    try {
      const body = await apiJson(`/api/tasks/${summary.id}`);
      accordion.innerHTML = renderAccordionBody(body.task);
      accordion.dataset.loaded = 'true';
    } catch {
      accordion.textContent = '加载任务详情失败';
      accordion.classList.add('hidden');
      item.classList.remove('open');
    }
  } else {
    accordion.classList.add('hidden');
    item.classList.remove('open');
  }
}

$('token-save').addEventListener('click', () => {
  const value = $('token-input').value.trim();
  if (value === '') {
    setTokenError('token 不能为空');
    return;
  }
  token = value;
  localStorage.setItem(TOKEN_KEY, token);
  streamEvents();
  refreshTasks();
});

$('token-btn').addEventListener('click', () => {
  $('token-bar').classList.toggle('hidden');
  $('token-input').value = '';
});

$('run-form').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault();
  const task = $('task-input').value.trim();
  if (task === '') {
    return;
  }
  const payload = { task, yes: $('opt-yes').checked, noVerify: $('opt-noverify').checked };
  const verify = $('opt-verify').value.trim();
  if (verify !== '') {
    payload.verify = verify;
  }
  chat.innerHTML = '';
  planBubble = undefined;
  confirmBubble = undefined;
  clearDecisionRef();
  currentTaskId = undefined;
  pendingPlanSummary = undefined;
  pendingConfirmRequest = undefined;
  planTotal = 0;
  completedSteps = 0;
  lastVerificationFailed = false;
  try {
    const body = await apiJson('/api/run', { method: 'POST', body: JSON.stringify(payload) });
    setStatus(body.status ?? 'running');
    addBubble('user', 'user', '新任务', task);
    $('task-input').value = '';
  } catch (error) {
    if (error.message !== 'unauthorized') {
      addBubble('agent', 'error', '提交失败', error.message);
    }
  }
});

$('abort-btn').addEventListener('click', async () => {
  try {
    await apiJson('/api/abort', { method: 'POST', body: JSON.stringify({}) });
  } catch (error) {
    if (error.message !== 'unauthorized') {
      addBubble('agent', 'error', '中止失败', error.message);
    }
  }
});

$('refresh-tasks').addEventListener('click', refreshTasks);

if (token) {
  streamEvents();
} else {
  showTokenBar('请输入 serve 启动时打印的 token');
}
refreshTasks();
