export const KEY = 'rp_director_v1';
export const DEFAULTS = { enabled: true, interval: 8, adaptive: true, activity: 'balanced', maxLevel: 2, integrity: true, care: true, major: false, npc: 'normal' };
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const clamp = (v, a, b, fallback = a) => Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Math.round(Number(v)))) : fallback;
export const freshState = (settings) => ({ version: 1, epoch: uid(), initialInterval: clamp(settings.interval, 3, 20, 8), force: false });
export const clean = (v, max = 100) => typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, ' ').slice(0, max).trim() : '';
export function stripStatus(text) {
    // Remove only our namespaced tail, including truncated streaming output.
    return String(text ?? '').replace(/<!--\s*RPDIR:[\s\S]*?(?:-->|$)/g, '')
        .replace(/\[\[RPDIR:[\s\S]*?(?:\[\[\/RPDIR\]\]|$)/g, '').trimEnd();
}
const compact = text => String(text ?? '').replace(/\s+/g, '');
const comparable = text => compact(text).replace(/[\p{P}\p{S}]/gu, '');
export const advances = r => r?.protocol === 3 && !r.rejected && ['internal', 'new', 'transition'].includes(r.action);
export const PHASES = { active: '发展中', settling: '收尾', calm: '平淡', stagnant: '停滞' };
export const ACTIONS = { internal: '内部推进', new: '开启新事', transition: '自然过渡', seed: '仅铺垫', hold: '暂缓' };
export const SOURCES = { agency: '角色主动', world: '世界变化', consequence: '已有事情的后果', none: '无', unknown: '未报告' };
export const DIMENSIONS = { information: '重要信息', decision: '决定与行动', relationship: '关系局面', options: '机会与限制', consequence: '实际后果', closure: '收尾与过渡', none: '无', unknown: '未报告' };

// Recover innocuous formatting only: code fences, numeric/boolean strings and missing optional metadata.
// Never infer a story event from prose or invent the required before/after/effect/evidence.
export function parseStatus(text, nonce, settings, history = [], diagnostic = {}) {
    const fail = (code, message, fields = []) => {
        Object.assign(diagnostic, { code, message, fields });
        return null;
    };
    const body = String(text ?? '');
    const blocks = [
        ...[...body.matchAll(/<!--\s*RPDIR:([\w-]+)\s+([\s\S]*?)-->/g)].map(x => ({ nonce: x[1], json: x[2], index: x.index })),
        ...[...body.matchAll(/\[\[RPDIR:([\w-]+)\]\]([\s\S]*?)\[\[\/RPDIR\]\]/g)].map(x => ({ nonce: x[1], json: x[2], index: x.index })),
    ].sort((a, b) => a.index - b.index);
    const block = blocks.findLast(x => x.nonce === nonce);
    if (!block) return fail(blocks.length ? 'nonce_mismatch' : /(?:<!--\s*RPDIR:|\[\[RPDIR:)/.test(body) ? 'incomplete' : 'missing',
        blocks.length ? '收到的报告编号不属于本次检查。' : /(?:<!--\s*RPDIR:|\[\[RPDIR:)/.test(body) ? '报告开始了，但结尾不完整，可能输出被截断。' : '插件读到的回复中没有导演报告标记；可能未输出，或在读取前被过滤。');
    let raw;
    try { raw = JSON.parse(block.json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { return fail('invalid_json', '已收到报告，但JSON无法读取。'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_json', '导演报告必须是JSON对象。');
    try {
        const fixes = [];
        const number = (field, fallback) => {
            if (raw[field] == null && fallback !== undefined) { fixes.push(field); return fallback; }
            if (typeof raw[field] === 'string' && /^\d+$/.test(raw[field].trim())) { fixes.push(field); return Number(raw[field]); }
            return raw[field];
        };
        const level = number('level'), next = number('next', clamp(settings.interval, 3, 20, 8));
        const source = raw.source ?? (raw.action === 'hold' ? 'none' : 'unknown');
        const dimension = raw.dimension ?? (['hold','seed'].includes(raw.action) ? 'none' : 'unknown');
        const surprise = typeof raw.surprise === 'string' && /^(true|false)$/.test(raw.surprise)
            ? (fixes.push('surprise'), raw.surprise === 'true') : raw.surprise ?? false;
        const invalid = [];
        if (raw.protocol != null && Number(raw.protocol) !== 3) invalid.push('protocol');
        if (!Object.hasOwn(PHASES, raw.phase)) invalid.push('phase');
        if (!Object.hasOwn(ACTIONS, raw.action)) invalid.push('action');
        if (!Object.hasOwn(SOURCES, source)) invalid.push('source');
        if (!Object.hasOwn(DIMENSIONS, dimension)) invalid.push('dimension');
        if (typeof surprise !== 'boolean') invalid.push('surprise');
        if (!Number.isInteger(level) || level < 0 || level > 4) invalid.push('level');
        if (!Number.isInteger(next)) invalid.push('next');
        if (invalid.length) return fail('invalid_fields', `已收到报告，但字段不符合格式：${invalid.join('、')}。`, invalid);
        const r = { protocol: 3, phase: raw.phase, action: raw.action, source, dimension, surprise, level };
        for (const field of ['summary', 'before', 'after', 'effect', 'evidence', 'thread', 'goal', 'obstacle', 'open', 'seed', 'link']) r[field] = clean(raw[field], 120);
        for (const field of ['domain', 'target', 'entry', 'tone']) r[field] = clean(raw[field], 30);
        r.memoryFields = ['thread','goal','obstacle','open','seed','after'].filter(field => typeof raw[field] === 'string');
        const changed = advances(r);
        let issue = '';
        if (!r.summary) issue = '缺少本次判断的简短说明。';
        else if (changed && (!r.before || !r.after)) issue = '缺少前后局面说明。';
        else if ((r.action === 'hold') !== (r.level === 0)) issue = '处理方式与影响尺度矛盾。';
        else if (r.dimension !== 'unknown' && changed !== (r.dimension !== 'none')) issue = '没有说明局面改变在哪个方面。';
        else if (r.action === 'hold' && (r.source !== 'none' || r.surprise)) issue = '暂缓报告不能同时声称引入了意外或主动变化。';
        else if (r.action !== 'hold' && r.source === 'none') issue = '缺少这次变化的来源。';
        else if (changed && (comparable(r.before) === comparable(r.after) || !r.effect)) issue = '前后局面没有区别，或未说明对后续的实际影响。';
        else if (r.action === 'seed' && !r.seed) issue = '未说明正文中新出现的待发展线索。';
        else if (r.action !== 'hold' && (compact(r.evidence).length < 8 || !compact(stripStatus(text)).includes(compact(r.evidence)))) issue = '本轮正文中找不到报告引用的原句。';
        else if (r.phase === 'active' && r.source === 'world' && !r.link) issue = '已有事件正在发展，但未说明外部变化与当前事件的因果联系。';
        else if (changed && history.some(h => advances(h.result) && comparable(h.result.after) === comparable(r.after))) issue = '局面与近期已报告的结果相同，不能再次计为推进。';
        if (issue) { Object.assign(diagnostic, { code: 'rejected', message: issue, fields: [] }); return { protocol: 3, phase: r.phase, action: 'hold', source: 'none', dimension: 'none', surprise: false,
            level: 0, next: 2, rejected: true, issue, summary: r.summary, reportedAction: r.action }; }
        const limits = { quiet: [6, 16], balanced: [4, 12], lively: [3, 8] }[settings.activity] ?? [4, 12];
        r.next = settings.adaptive ? clamp(next, ...limits) : clamp(settings.interval, 3, 20, 8);
        // Calm breathing room is allowed. Only reported stagnation needs an early recheck.
        if (settings.adaptive && r.phase === 'stagnant') r.next = Math.min(r.next, 3);
        const cap = Math.min(clamp(settings.maxLevel, 1, 4, 2), settings.major ? 4 : 3);
        r.warning = r.level > cap ? '模型报告的影响尺度超过设置，请检查正文。' : '';
        Object.assign(diagnostic, { code: 'ok', message: fixes.length ? `已兼容格式偏差：${fixes.join('、')}。` : '报告已读取。', fields: [], normalized: fixes });
        return r;
    } catch { return fail('read_error', '报告读取出现异常。'); }
}

// Derive memory from the selected replies, so swipes, deletion and reset also roll it back.
export function storyView(history, total) {
    let story = null, noProgressChecks = 0, unverifiedChecks = 0, lastChange = null;
    for (const h of history) {
        const r = h.result;
        if (r?.protocol !== 3 || r.rejected) { unverifiedChecks++; continue; }
        const fields = r.memoryFields ?? ['thread','goal','obstacle','open','seed','after'];
        if (story || r.thread || r.after) {
            story = { thread: '', goal: '', obstacle: '', open: '', situation: '', seed: '', ...story, round: h.round };
            for (const field of fields) story[field === 'after' ? 'situation' : field] = r[field];
        }
        if (advances(r)) {
            noProgressChecks = 0;
            lastChange = { round: h.round, before: r.before, after: r.after, effect: r.effect };
        } else noProgressChecks++;
    }
    return { story, noProgressChecks, unverifiedChecks, lastChange, roundsSinceChange: lastChange ? total - lastChange.round : null };
}

export function describeResult(r, diagnostic, retry = 2) {
    if (!r) return `报告读取失败\n${diagnostic?.message || '旧版记录没有保留失败原因，无法追溯是未输出还是格式错误。'}\n${retry}回合后检查；这不能证明正文没有推进。`;
    if (r.rejected) return `报告未通过核对\n${r.issue}\n这不代表正文一定没有推进；${retry}回合后重新检查。`;
    if (r.protocol !== 3) return '旧版记录：未按前后局面评估，不作为新版的实质推进依据。';
    const change = advances(r)
        ? `模型报告局面有变化 · ${DIMENSIONS[r.dimension]}\n此前：${r.before}\n现在：${r.after}\n后续影响：${r.effect}`
        : `本次未报告实质变化\n${r.summary}${r.seed ? `\n待发展：${r.seed}` : ''}`;
    return `判断：${PHASES[r.phase]} · 处理：${ACTIONS[r.action]} · L${r.level}\n来源：${SOURCES[r.source]}${r.surprise ? ' · 有意外变化' : ''}\n${change}${r.warning ? `\n${r.warning}` : ''}`;
}
export function selectedRecord(message) {
    if (Array.isArray(message.swipe_info) && Number.isInteger(message.swipe_id)) {
        const info = message.swipe_info[message.swipe_id];
        if (info?.extra) return info.extra[KEY];
    }
    return message.extra?.[KEY];
}
export function derive(chat, state, settings, excludedTurn = '') {
    const seen = new Set();
    const valid = new Set();
    const records = [];
    let currentUser = '';
    for (const m of chat) {
        if (m.is_user && !m.is_system) {
            const u = m.extra?.[KEY];
            currentUser = u?.epoch === state.epoch ? u.id : '';
            if (currentUser) valid.add(currentUser);
            continue;
        }
        if (m.is_system || !stripStatus(m.mes).trim()) continue;
        const r = selectedRecord(m);
        if (!r || r.epoch !== state.epoch || !valid.has(r.turn) || r.turn !== currentUser || r.turn === excludedTurn || seen.has(r.turn)) continue;
        seen.add(r.turn);
        records.push(r);
    }
    let lastCheck = 0;
    let interval = state.initialInterval;
    let failureChecks = 0;
    const history = [];
    records.forEach((r, i) => {
        if (r.check) {
            lastCheck = i + 1;
            const failed = !r.result || r.result.rejected;
            failureChecks = failed ? failureChecks + 1 : 0;
            interval = failed ? retryInterval(failureChecks, settings) : r.result.next;
            history.push({ ...r, round: i + 1, retry: !r.result || r.result.rejected ? interval : null });
        }
    });
    // A fixed interval takes effect immediately, except for a failed-report retry.
    const last = history.at(-1);
    if (!settings.adaptive && !(last && (!last.result || last.result.rejected))) interval = clamp(settings.interval, 3, 20, 8);
    return { total: records.length, progress: records.length - lastCheck, interval, history: history.slice(-5), records, failureChecks,
        ...storyView(history, records.length) };
}
export function retryInterval(failures, settings) {
    const base = clamp(settings.interval, 3, 20, 8);
    return failures === 1 ? 2 : failures === 2 ? 4 : Math.max(4, base);
}
export function buildPrompt(settings, state, view, nonce) {
    const recent = view.history.filter(x => x.result).map(x => {
        const r = x.result;
        return r.protocol === 3 && !r.rejected
            ? { round: x.round, phase: r.phase, action: r.action, source: r.source, surprise: r.surprise, before: r.before, after: r.after, effect: r.effect, entry: r.entry, tone: r.tone }
            : { round: x.round, unverified: true, note: r.issue || r.summary };
    });
    const cap = Math.min(clamp(settings.maxLevel, 1, 4, 2), settings.major ? 4 : 3);
    return `[RP Director｜本轮剧情检查，随正文执行，不展示分析]
先读当前实际聊天与世界背景，再参考下方短记忆。识别局面→选择推动方式→用本轮实际正文回看变化。不是先写重复互动再给动作贴“推进”标签；也不另起一段导演说明。
【阶段与停滞】phase为本轮推动之前的局面：active=有未解决事项且近期确有发展；settling=关键结果已产生，待落实余波/过渡；calm=没有占据场景的事项，可安静相处或开启新事；stagnant=跨多轮重复同一问题、情绪、姿态，局面未变。情感拉扯可以是真剧情，但还在说话、动作变了、时间过去不自动等于发展。停滞可发生在任何场景；按实际聊天判断，不以进度满格认定停滞。
【角色主动】Char在各阶段都有自己的目的、顾虑和判断，能依人设主动表达诉求、透露重要信息、改变策略、落实选择、承担后果。心理要能影响行动，行动要能影响后续；克制/犹豫/回避是阶段选择，不是永久冻结的行为。勿强制见面、和好或改变关系，不代替User决定行动、心理和回应，也不要求每次以提问或台词结束。
【已有事件】active优先internal：找出尚未解决的问题，使它朝解决、升级、转向或结束迈一步。settling优先落实后果并自然transition；不要无穷延长已耗尽的场景。可有事件内部未预料到的信息、反应或后果；无关外部突发不能把投入中的戏截走。source=world时必须说明它与当前事件的因果联系link。
【意外与世界自主变化】calm或自然收尾后，积极考虑new：Char自己的愿望/责任/计划、他人的自主行动、环境与社会变化、已有行为的后果，都可带来User未预先安排而世界内合理的新事。意外可以是好事、机会、发现、巧合、麻烦或转折；惊喜程度不等于灾难程度。不固定轮流、不按例子抽签、不总绕着双方制造服务性配角。新情况要影响可选行动、产生后果或打开可持续发展的事项，不能露面即消失、马上恢复原状。允许阶段性平静，但不能以“自然、不打断”为由无限拒绝新事。
【尺度与多样性】L0暂缓；L1场景内变化/小插曲；L2数轮支线；L3较持久的重要变化；L4长期转折。本轮上限L${cap}；较大变化需要相应背景因果与铺垫。${settings.major ? '允许有充分依据的重大危机，不随机降临。' : '重大危机关闭，不新增重大伤病、灾难、死亡或永久性损失。'}活跃度=${settings.activity}，影响节奏而非灾难强度；新NPC倾向=${settings.npc}，须有合理身份与动机。来源可涉及生活、共同计划、工作责任、社交、其他人的生活、机会、环境、社会与旧事后果；这些是发散维度而非固定剧情清单。改变起因、对象、表现和情绪，勿反复套相同入口。
${settings.integrity ? '保留Char核心能力与人格定位，不以随机事件使其重伤卧床、持续衰弱、破产、无能或长期依赖User照顾。' : '变化须符合人设与世界因果。'}${settings.care ? '合适时给Char照顾与解决问题的空间，不为此反复伤害User。' : ''}
【实质推进标准】比较此前局面与本轮结束：重要信息是否改变判断；不同的决定是否开始落实；关系、机会、限制或代价是否变化；旧事是否产生实际后果、得到解决或自然结束。至少一项对后续有影响才算internal/new/transition。新动作、无关生活细节、换说法、重复心理、再次选择维持现状不算。不能只用“关系更深/气氛变化”等空泛评语充数。before/after须描述可区别的实际局面，effect说明它如何改变后续。准备做不等于做完；真实承诺可改变局面，但不能虚构执行结果。seed仅是正文中新铺垫，hold暂缓，均不计实质推进。不必每轮发生变化。
【连续检查】最近${view.noProgressChecks ?? 0}次有效检查连续未报告实质推进；距上次有效报告的变化${view.roundsSinceChange ?? '未知'}个回合。缺失/旧版/未通过报告不证明停滞。此计数仅提醒：先核对检查之间正文是否已发展。若实际仍重复，逐步要求不同的实质行动或让既有选择产生后果；内部无空间就收尾过渡，在适合时提高新事与意外倾向。加强行动有效性，不升级灾难、不突然转性、不强行解决关系。
【短记忆，仅参考，正文为准】${JSON.stringify(view.story ?? null)}
上次报告的实质变化：${JSON.stringify(view.lastChange ?? null)}
近期检查：${JSON.stringify(recent)}
【报告必须输出】剧情正文后另起一行，输出下面的专用文本区块。不要使用HTML注释，不要把报告省略；这是插件数据，插件会自动从显示与聊天正文移除。其他文风、结尾或状态栏要求仅适用于正文。
[[RPDIR:${nonce}]]
{"phase":"calm","action":"hold","level":0,"summary":"本次判断与暂缓理由","before":"此前局面","after":"本轮结束局面","effect":"","evidence":"","thread":"当前主要事项","goal":"角色目标","obstacle":"阻碍","open":"待解决事项","seed":"","next":8}
[[/RPDIR]]
照此格式按实际填写。必填phase=active/settling/calm/stagnant，action=internal/new/transition/seed/hold，level=0–${cap}整数，summary=简短判断。hold用L0，其他用L1–L${cap}。internal/new/transition必须before、after、effect；非hold必须evidence逐字摘本轮正文8–50字，seed需具体seed。thread/goal/obstacle/open/after记录实际状态，不预测不虚构；已解决项清空。可补source=agency/world/consequence、surprise=true/false、dimension=information/decision/relationship/options/consequence/closure；未补则不猜来源或维度。active中的外部变化须补source=world与link因果联系。各说明不超过40字，next为3–16整数。`;
}
