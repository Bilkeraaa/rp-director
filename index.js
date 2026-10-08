import { KEY, DEFAULTS, uid, freshState, derive, parseStatus, stripStatus, buildPrompt, clamp, describeResult } from './core.mjs?v=1.2.0';

const ctx = () => SillyTavern.getContext();
let pending = null;
let busy = false;
let stopped = false;
let notice = '';
let root;
const chatKey = c => `${c.groupId ?? ''}|${c.characterId ?? ''}|${c.chatId ?? c.getCurrentChatId?.() ?? ''}`;
const hasChat = c => c.chatId != null || c.getCurrentChatId?.() != null;
function settings() {
    const c = ctx();
    c.extensionSettings[KEY] ??= { ...DEFAULTS };
    return { ...DEFAULTS, ...c.extensionSettings[KEY] };
}
function state() {
    const c = ctx();
    if (!hasChat(c)) return null;
    if (!c.chatMetadata[KEY]?.epoch) {
        c.chatMetadata[KEY] = freshState(settings());
        c.saveMetadataDebounced?.();
    }
    return c.chatMetadata[KEY];
}
function clearPrompt() { ctx().setExtensionPrompt(KEY, '', 1, 0, false, 0); }
function syncSwipe(m) {
    if (!Number.isInteger(m.swipe_id)) return;
    if (m.swipes) m.swipes[m.swipe_id] = m.mes;
    if (m.swipe_info) {
        m.swipe_info[m.swipe_id] ??= {};
        m.swipe_info[m.swipe_id].extra ??= {};
        if (m.extra?.[KEY]) m.swipe_info[m.swipe_id].extra[KEY] = structuredClone(m.extra[KEY]);
        else delete m.swipe_info[m.swipe_id].extra[KEY];
    }
}
function latestUser(c, before = c.chat.length) {
    for (let i = before - 1; i >= 0; i--) if (c.chat[i].is_user && !c.chat[i].is_system) return c.chat[i];
    return null;
}

globalThis.rpDirectorInterceptor = async (_chat, _size, _abort, type = 'normal') => {
    clearPrompt();
    pending = null;
    const c = ctx(), s = settings(), st = state();
    if (!st || !s.enabled || !['normal', 'regenerate', 'swipe'].includes(type)) return;
    const user = latestUser(c);
    if (!user) return;
    user.extra ??= {};
    if (user.extra[KEY]?.epoch !== st.epoch) user.extra[KEY] = { id: uid(), epoch: st.epoch };
    const turn = user.extra[KEY].id;
    const full = derive(c.chat, st, s);
    if (type === 'normal' && full.records.some(r => r.turn === turn)) return;
    const view = derive(c.chat, st, s, turn);
    const check = st.force || view.progress + 1 >= view.interval;
    pending = { key: chatKey(c), chat: c.chat, epoch: st.epoch, turn, user, check, nonce: uid(), settings: { ...s }, history: view.history, used: false };
    stopped = false;
    if (check) c.setExtensionPrompt(KEY, buildPrompt(s, st, view, pending.nonce), 1, 0, false, 0);
    render();
};

async function received(id, type) {
    const c = ctx();
    const m = c.chat[Number(id)];
    if (!m || m.is_user || m.is_system || type === 'first_message') return;
    const original = String(m.mes ?? '');
    const cleaned = stripStatus(original);
    const p = pending;
    const st = state();
    const aborted = stopped || Boolean(c.streamingProcessor?.abortController?.signal?.aborted);
    const matching = p && !p.used && !aborted && st?.epoch === p.epoch && chatKey(c) === p.key && c.chat === p.chat && latestUser(c, Number(id)) === p.user;
    if (matching && cleaned.trim()) {
        p.used = true;
        const result = p.check ? parseStatus(original, p.nonce, p.settings, p.history) : null;
        m.extra ??= {};
        m.extra[KEY] = { epoch: p.epoch, turn: p.turn, check: p.check, result, at: new Date().toISOString() };
        if (p.check) st.force = false;
        notice = p.check && !result ? '本轮已完成，但模型未回传有效导演状态；2个有效回合后重试。' : result?.rejected ? `${result.issue}2个有效回合后重试。` : '';
    } else if (p && !p.used && aborted && st?.epoch === p.epoch && c.chat === p.chat && latestUser(c, Number(id)) === p.user) {
        // Swipes may inherit the previous reply's extra fields. An aborted replacement is not a completed turn.
        if (m.extra) delete m.extra[KEY];
    }
    if (cleaned !== original) m.mes = cleaned;
    if (matching || cleaned !== original || aborted) {
        syncSwipe(m);
        // ST's normal receive path renders and persists after this awaited event.
        if (cleaned !== original) c.updateMessageBlock?.(Number(id), m);
        c.saveMetadataDebounced?.();
    }
    render();
}

function render() {
    if (!root) return;
    const c = ctx(), s = settings(), st = state();
    const v = st ? derive(c.chat, st, s) : { progress: 0, interval: s.interval, total: 0, history: [] };
    root.querySelector('[data-progress]').textContent = `${v.progress} / ${v.interval}`;
    root.querySelector('progress').max = v.interval;
    root.querySelector('progress').value = Math.min(v.progress, v.interval);
    root.querySelector('[data-total]').textContent = `本次累计 ${v.total} 个有效回合 · 每个聊天独立`;
    root.querySelector('[data-mode]').textContent = s.adaptive ? `自动间隔 · 本周期 ${v.interval} 回合；报告停滞时提前复查` : `固定间隔 · ${s.interval} 回合；报告异常时2回合重试`;
    const checking = pending?.check && !pending.used && busy;
    const last = v.history.at(-1);
    root.querySelector('[data-status]').textContent = !st ? '先打开一个聊天。' : notice || (!s.enabled ? '已暂停。' : checking ? '本轮正在随正文检查剧情…' : st.force ? '已安排：下次正常回复检查。' : last?.check && (!last.result || last.result.rejected) ? '上次报告未通过，将自动重试。' : `再完成 ${Math.max(1, v.interval - v.progress)} 个回合检查；不会单独调用模型。`);
    root.querySelector('[data-status]').classList.toggle('rpd-error', Boolean(notice || (last?.check && (!last.result || last.result.rejected))));
    root.querySelector('[data-last]').textContent = !last ? '尚无检查结果。满格时判断当前剧情适合内部推进、过渡还是开启新事。' : describeResult(last.result);
    root.querySelector('[data-story]').textContent = v.story
        ? `当前事项：${v.story.thread}\n角色目标：${v.story.goal || '未明确'}\n阻碍：${v.story.obstacle || '无明确阻碍'}\n待解决：${v.story.open || '无'}\n${v.lastChange ? `上次报告的实质变化：第 ${v.lastChange.round} 回合 · ${v.lastChange.after}\n此后累计 ${v.roundsSinceChange} 个回合` : '尚无新版实质变化报告'}\n连续 ${v.noProgressChecks} 次有效检查未报告实质变化（仅供判断，不等于必然停滞）`
        : '首次新版检查后形成剧情短记忆，随当前回复版本保存。';
    for (const el of root.querySelectorAll('[data-setting]')) {
        const val = s[el.dataset.setting];
        if (el.type === 'checkbox') el.checked = Boolean(val); else el.value = String(val);
        el.disabled = busy;
    }
    for (const el of root.querySelectorAll('[data-action]')) el.disabled = busy || !st;
    root.querySelector('[data-action=check]').disabled = busy || !st || !s.enabled;
    const log = root.querySelector('[data-history]');
    log.replaceChildren();
    if (!v.history.length) log.textContent = '尚未检查。';
    for (const record of [...v.history].reverse()) {
        const el = document.createElement('div'); el.className = 'rpd-log';
        const r = record.result;
        el.textContent = `第 ${record.round} 回合 · ${describeResult(r)}${r?.evidence ? `\n正文原句：${r.evidence}` : ''}\n当时安排间隔 ${r?.next ?? 2} 回合`;
        el.style.whiteSpace = 'pre-line'; log.append(el);
    }
}

function mount() {
    if (document.getElementById('rpd-panel')) return;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'extension_container';
    wrapper.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>RP Director · 剧情导演 <small>1.2.0</small></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><div id="rpd-panel">
      <div class="rpd-top"><span>距离下次剧情检查</span><label><input type="checkbox" data-setting="enabled">启用</label></div>
      <div class="rpd-big" data-progress></div><progress value="0" max="8" aria-label="剧情检查进度"></progress>
      <div class="rpd-muted" data-total></div><div class="rpd-muted" data-mode></div><div class="rpd-status" data-status role="status" aria-live="polite"></div><div class="rpd-last" data-last></div>
      <div class="rpd-actions"><button class="menu_button" data-action="check">下次回复检查</button><button class="menu_button rpd-danger" data-action="reset">清空进度，重新累计</button></div>
      <div class="rpd-muted">清空只重置此聊天的导演计数、记录和待检查状态。聊天及记忆台不变。</div>
      <details><summary>导演设置</summary><div class="rpd-controls">
      <label class="rpd-field">基础间隔（3–20回合）<input class="text_pole" type="number" min="3" max="20" data-setting="interval"></label>
      <label class="rpd-field">剧情活跃度<select class="text_pole" data-setting="activity"><option value="quiet">舒缓</option><option value="balanced">适中</option><option value="lively">活跃</option></select></label>
      <label class="rpd-field">变化影响上限<select class="text_pole" data-setting="maxLevel"><option value="1">L1 小插曲</option><option value="2">L2 支线（默认）</option><option value="3">L3 重要事件</option><option value="4">L4 重大转折</option></select></label>
      <label class="rpd-field">新NPC倾向<select class="text_pole" data-setting="npc"><option value="low">少引入</option><option value="normal">顺其自然</option><option value="high">较丰富</option></select></label>
      <label><input type="checkbox" data-setting="adaptive">AI调整下次间隔</label><label><input type="checkbox" data-setting="integrity">保留Char核心能力</label>
      <label><input type="checkbox" data-setting="care">偏好照顾型互动</label><label><input type="checkbox" data-setting="major">允许重大危机</label>
      </div><p class="rpd-muted">关闭“AI调整下次间隔”可固定回合数，立即生效。自动模式下基础间隔用于清空后的首次检查。重大危机默认关闭。先判断发展中、收尾、平淡或停滞，再选择内部推进、自然过渡或新事。意外可来自角色主动、外部世界或已有后果，不固定抽签。原句与结构核对不能保证模型准确判断剧情质量。</p></details>
      <details><summary>当前剧情短记忆</summary><div class="rpd-story" data-story></div></details>
      <details><summary>最近5次检查</summary><div data-history></div></details>
      <p class="rpd-muted">一条用户消息获得有效回复算1回合；开场白、续写、重生成不额外累计。切换回复版本和删除消息时，进度随当前记录重新计算。</p>
    </div></div></div>`;
    host.append(wrapper); root = wrapper.querySelector('#rpd-panel');
    root.addEventListener('change', e => {
        const key = e.target.dataset.setting; if (!key) return;
        const value = e.target.type === 'checkbox' ? e.target.checked : ['interval','maxLevel'].includes(key) ? clamp(e.target.value, key === 'interval' ? 3 : 1, key === 'interval' ? 20 : 4, 8) : e.target.value;
        ctx().extensionSettings[KEY][key] = value;
        ctx().saveSettingsDebounced(); clearPrompt(); render();
    });
    root.addEventListener('click', async e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action || busy || !state()) return;
        const c = ctx();
        if (action === 'reset') {
            c.chatMetadata[KEY] = freshState(settings()); pending = null; clearPrompt();
            notice = '已清空，从 0 开始重新累计。';
        } else { state().force = true; notice = ''; }
        render();
        try { await c.saveMetadata(); } catch { notice = '保存失败，请检查连接后重试。'; render(); }
    });
    render();
}

function init() {
    const c = ctx(), ev = c.eventTypes ?? c.event_types;
    settings(); mount();
    if (c.messageFormatter) c.messageFormatter.addHook(text => stripStatus(text), { stage: c.messageFormatter.stage.BEFORE_REGEX });
    const on = (name, fn) => { if (ev[name]) c.eventSource.on(ev[name], fn); };
    on('APP_READY', mount);
    on('GENERATION_STARTED', (type, _options, dryRun) => {
        clearPrompt();
        if (dryRun || type === 'quiet') return;
        pending = null; busy = true; stopped = false; notice = ''; render();
    });
    on('GENERATION_STOPPED', () => { stopped = true; notice = '本轮已停止，未完成的回复不累计。'; render(); });
    on('MESSAGE_RECEIVED', received);
    c.eventSource.makeFirst?.(ev.MESSAGE_RECEIVED, received);
    on('GENERATION_ENDED', () => {
        // Streaming emits ENDED before RECEIVED. Clear injections now, retain the ticket until the next request.
        clearPrompt(); busy = false; render();
    });
    on('CHAT_CHANGED', () => { pending = null; busy = false; stopped = false; notice = ''; clearPrompt(); mount(); render(); });
    for (const name of ['MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED','MESSAGE_DELETED','MESSAGE_EDITED','CHARACTER_MESSAGE_RENDERED']) on(name, render);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
