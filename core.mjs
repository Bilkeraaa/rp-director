export const KEY = 'rp_director_v1';
export const DEFAULTS = { enabled: true, interval: 8, adaptive: true, activity: 'balanced', maxLevel: 2, integrity: true, care: true, major: false, npc: 'normal' };
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const clamp = (v, a, b, fallback = a) => Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Math.round(Number(v)))) : fallback;
export const freshState = (settings) => ({ version: 1, epoch: uid(), initialInterval: clamp(settings.interval, 3, 20, 8), force: false });
export const clean = (v, max = 100) => typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, ' ').slice(0, max).trim() : '';
export function stripStatus(text) {
    // Remove only our namespaced tail, including truncated streaming output.
    return String(text ?? '').replace(/<!--\s*RPDIR:[\s\S]*?(?:-->|$)/g, '').trimEnd();
}
const compact = text => String(text ?? '').replace(/\s+/g, '');
export function parseStatus(text, nonce, settings, history = []) {
    const blocks = [...String(text).matchAll(/<!--\s*RPDIR:([\w-]+)\s+(\{[\s\S]*?\})\s*-->/g)];
    const block = blocks.findLast(x => x[1] === nonce);
    if (!block) return null;
    try {
        const r = JSON.parse(block[2]);
        if (!['active', 'settling', 'calm', 'stagnant'].includes(r.phase) || !['none', 'seed', 'event'].includes(r.action)) return null;
        if (!Number.isInteger(r.level) || r.level < 0 || r.level > 4 || !Number.isInteger(r.next)) return null;
        const limits = { quiet: [6, 16], balanced: [4, 12], lively: [3, 8] }[settings.activity] ?? [4, 12];
        let next = settings.adaptive ? clamp(r.next, ...limits) : clamp(settings.interval, 3, 20, 8);
        const cap = Math.min(clamp(settings.maxLevel, 1, 4, 2), settings.major ? 4 : 3);
        const change = clean(r.change, 100), hook = clean(r.hook, 100), evidence = clean(r.evidence, 120);
        let issue = '';
        if ((r.action === 'none') !== (r.level === 0)) issue = '事件类型与等级矛盾，未计为新事件。';
        else if (r.action !== 'none' && (!change || (r.action === 'event' && !hook) || (r.action === 'seed' && !clean(r.seed, 90)))) issue = '未说明具体新增内容或可互动事项，未计为新事件。';
        else if (r.action !== 'none' && (compact(evidence).length < 8 || !compact(stripStatus(text)).includes(compact(evidence)))) issue = '在本轮正文中找不到对应原句，未计为新事件。';
        else if (r.action === 'event' && history.some(h => h.result?.protocol === 2 && h.result.action === 'event' && !h.result.rejected && compact(h.result.change) === compact(change))) issue = '新增内容与近期记录相同，未计为新事件。';
        if (issue) return { protocol: 2, phase: r.phase, action: 'none', level: 0, next: 2, summary: clean(r.summary, 100), rejected: true, issue, seed: '', reportedAction: r.action };
        if (settings.adaptive && r.action !== 'event') next = Math.min(next, r.phase === 'active' ? 4 : 3);
        return { protocol: 2, phase: r.phase, action: r.action, level: r.level, next, change, hook, evidence,
            domain: clean(r.domain, 24), target: clean(r.target, 24), entry: clean(r.entry, 30), tone: clean(r.tone, 18),
            summary: clean(r.summary, 100), seed: clean(r.seed, 90), warning: r.level > cap ? '模型报告的事件等级超过设置，请检查正文。' : '' };
    } catch { return null; }
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
    const history = [];
    records.forEach((r, i) => {
        if (r.check) {
            lastCheck = i + 1;
            interval = r.result?.next ?? 2;
            history.push({ ...r, round: i + 1 });
        }
    });
    // A fixed interval takes effect immediately, except for a failed-report retry.
    const last = history.at(-1);
    if (!settings.adaptive && !(last && (!last.result || last.result.rejected))) interval = clamp(settings.interval, 3, 20, 8);
    let noEventChecks = 0;
    for (const h of [...history].reverse()) {
        if (h.result?.protocol === 2 && h.result.action === 'event' && !h.result.rejected) break;
        noEventChecks++;
    }
    return { total: records.length, progress: records.length - lastCheck, interval, history: history.slice(-5), records, noEventChecks };
}
export function buildPrompt(settings, state, view, nonce) {
    const recent = view.history.filter(x => x.result).map(x => {
        const r = x.result;
        return [r.action, r.domain, r.target, r.entry, `L${r.level}`, r.change || r.summary, r.rejected ? r.issue : ''].join('/');
    });
    const seed = [...view.history].reverse().find(x => x.result)?.result?.seed ?? '';
    return `[RP Director｜本轮检查，直接随正文执行，不展示分析]
先据时代、地域与社会稳定程度、User/Char身份地位与能力、人设、关系、场景、故事时间、近期剧情和已有NPC，推导此时此地合理的变化。不能把时代标签当固定模板，也不为抽中的类别改写世界。
判断 active（已有剧情：继续，勿加无关事件）、settling（收尾：写余波）、calm（日常：可引入变化）、stagnant（重复停滞：加强推进）。选择 none / seed / event；找不到自然入口就不加。优先兑现已有伏笔与行为后果，其次创造新事；seed只铺垫，不强制兑现，不堆积支线。
事件必须给正文新增具体事实、机会、障碍、安排或旧事的实际后果，留下User可回应/选择/处理的事情，不替User作决定。单纯亲近、占有宣言、人设展示、情绪升温和对既有关系换个说法都不算事件；关系变化只有带来具体新安排或后果才算。active只指有具体未解决的事情，不是因为人物还在说话就永远active。
seed必须是本轮正文实际出现的新迹象，不能只在状态里写“隐藏身世、潜在冲突”，也不能反复抄角色卡当伏笔。最近连续${view.noEventChecks ?? 0}次检查没有可核对的新事件（旧版报告也可能未核对）；达到2次时，若只是同类互动重复，应按stagnant处理，本轮优先自然引入L1–L2具体新事，或让已有冲突产生实质进展，勿继续空泛埋线；仍不硬切重要场景、不造灾难。
等级 L0无事件；L1短小插曲；L2数轮支线；L3影响一段时间，需背景依据；L4长期转折，需充分铺垫。日常以L0–L2为主，本轮上限L${Math.min(Number(settings.maxLevel), settings.major ? 4 : 3)}。${settings.major ? '允许有铺垫的重大转折，不能随机降临。' : '关闭重大危机，不新增重大伤病、灾难、死亡或永久性损失。'}
来源发散库（非抽卡清单）：生活/环境/物品｜家庭/共同计划｜社交/节庆｜工作/身份责任｜NPC自己的生活｜机会/好运/新体验｜轻度意外｜外部摩擦/利益冲突｜社会变化｜旧事后果｜新人/新地点。按世界条件筛选，自主细化；轮换User、Char、共同生活、NPC、组织及世界，不让某人总出事。好事、麻烦、温情、幽默、悬念均可。
${settings.integrity ? '保留Char既有核心能力与人格定位。可有压力、责任、竞争、暂时困难或轻微影响；不得以随机事件使其重伤卧床、持续衰弱、破产、无能或长期依赖User照顾。' : '所有变化仍须符合既有人设及世界因果。'}${settings.care ? '合适时给Char照顾与解决问题的空间，但不要为此反复伤害User。' : ''}不代替User决定行动、心理或回应，不强行改变双方关系。
从当前动作、环境、人物关系或旧信息自然接入，勿宣布新剧情，勿切断重要互动。避免重复电话/出差/加班/汇报/敲门/神秘消息、User受伤或Char工作出事。变换起因、表现、对象和情绪，而非只换名字。新NPC倾向=${settings.npc}，必须有合理来源，不强造固定配角；活跃度=${settings.activity}，不等于灾难强度。
近期检查记录（仅辅助去重，实际聊天正文为准）：${JSON.stringify(recent)}；待发展线索：${JSON.stringify(seed)}。
正文末尾仅附一条HTML注释（不用代码块）：<!--RPDIR:${nonce} {"phase":"calm","action":"none","level":0,"domain":"","target":"","entry":"","tone":"","summary":"不引入新事的具体理由","change":"","hook":"","evidence":"","seed":"","next":4}-->
按实际正文填写而非照抄：none只能L0；event/seed必须L1–L${Math.min(Number(settings.maxLevel), settings.major ? 4 : 3)}。event需change写新增的具体事、hook写留给User的互动机会；seed需change写新增迹象、seed写待发展线索。event/seed的evidence必须逐字摘录本轮正文中对应的8–50字原句，不能摘状态文字。各说明不超过40字；none时change/hook/evidence留空，summary说明暂缓理由。next为3–16整数；没有新事件时尽早再查。`;
}
