import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS as settings, KEY, freshState, parseStatus, advances, storyView, derive, stripStatus, describeResult, buildPrompt } from './core.mjs';
const prose = '他把拟好的合作方案交给对方，明确列出了双方可以协商的条款。';
const base = { protocol:3, phase:'active', action:'internal', source:'agency', surprise:false, dimension:'decision', level:1,
    next:8, summary:'把争论落实为可协商的方案', before:'双方对如何合作尚无具体方案', after:'已提出可协商的具体条款',
    effect:'双方可以开始协商责任与条件', evidence:'明确列出了双方可以协商的条款', thread:'协商合作', goal:'达成可行合作', obstacle:'利益分歧', open:'条款尚未达成一致', seed:'', link:'' };
const parse = (patch={}, opts=settings, history=[], body=prose) => parseStatus(`${body}\n<!--RPDIR:ticket ${JSON.stringify({...base,...patch})}-->`, 'ticket', opts, history);
const hold = {...base, action:'hold', source:'none', dimension:'none', level:0, after:base.before, effect:'', evidence:'', summary:'本轮保留思考空间'};
const rec = (result, round) => ({result,round});

test('internal advancement includes concrete before/after and does not require a forced question',()=>{
 const r=parse(); assert.ok(advances(r)); assert.equal(r.hook,undefined); assert.match(describeResult(r),/内部推进/); assert.match(describeResult(r),/后续影响/);
});
test('world surprises in calm scenes and causally connected turns during active scenes',()=>{
 assert.ok(advances(parse({phase:'calm',action:'new',source:'world',surprise:true,dimension:'options'})));
 assert.ok(parse({source:'world'}).rejected);
 assert.ok(advances(parse({source:'world',surprise:true,link:'对方对当前方案提出新的限制'})));
});
test('seed and breathing room are not scored as advancement',()=>{
 assert.equal(advances(parse(hold)),false); assert.equal(parse(hold).next,8);
 const seed=parse({action:'seed',dimension:'none',seed:'条款仍有未说明的依据'});
 assert.equal(advances(seed),false); assert.equal(seed.rejected,undefined);
 assert.equal(parse({...hold,phase:'stagnant'}).next,3);
});
test('rejects same situation, missing consequence and contradictory fields',()=>{
 for(const patch of [{after:base.before},{after:base.before+'。'},{effect:''},{dimension:'none'},{level:0},{source:'none'}]) assert.ok(parse(patch).rejected);
 assert.ok(parse({...hold,surprise:true}).rejected);
 assert.ok(parse({action:'seed',dimension:'none',seed:''}).rejected);
});
test('quote must exist in prose and cannot be supplied only by the hidden report',()=>{
 assert.ok(parse({evidence:'正文没有出现的所谓重要变化'}).rejected);
 assert.ok(parse({evidence:'很短'}).rejected);
 assert.equal(parse({},settings,[],prose.replace('明确','明 确')).rejected,undefined);
});
test('rejects duplicate recent outcomes while preserving a distinct new outcome',()=>{
 const prior=[rec(parse(),8)]; assert.ok(parse({},settings,prior).rejected);
 assert.ok(advances(parse({after:'提出第二套不同的合作条件'},settings,prior)));
});
test('malformed enums, stale nonce and old protocol cannot masquerade as new reports',()=>{
 for(const patch of [{protocol:2},{action:'event'},{phase:'unknown'},{source:'toString'},{dimension:'bogus'},{surprise:'maybe'},{next:2.5}]) assert.equal(parse(patch),null);
 assert.equal(parseStatus(`<!--RPDIR:old ${JSON.stringify(base)}-->`,'ticket',settings),null);
 assert.equal(stripStatus('正文\n<!--RPDIR:ticket {"phase":'),'正文');
});
test('fixed interval wins over pacing, cap violations remain visible and failures retry',()=>{
 const fixed={...settings,adaptive:false,interval:7}; assert.equal(parse({...hold,phase:'stagnant'},fixed).next,7);
 assert.equal(parse({level:4}).level,4); assert.match(parse({level:4}).warning,/超过/);
 assert.equal(parse({effect:''},fixed).next,2);
});
test('memory survives more than five checks; unverified reports do not assert stagnation',()=>{
 const history=[rec(parse(),1),...Array.from({length:6},(_,i)=>rec(parse(hold),i+2)),rec(null,8),rec({protocol:2,action:'event'},9),rec(parse({effect:''}),10)];
 const v=storyView(history,12); assert.equal(v.lastChange.round,1); assert.equal(v.noProgressChecks,6); assert.equal(v.unverifiedChecks,3); assert.equal(v.roundsSinceChange,11); assert.equal(v.story.round,7);
});
test('selected swipes, deletion, reset, serialization and old counters preserve correct story',()=>{
 const st=freshState(settings); const chat=[];
 const add=(id,result)=>{chat.push({is_user:true,mes:'讨论',extra:{[KEY]:{epoch:st.epoch,id}}},{mes:prose,extra:{[KEY]:{epoch:st.epoch,turn:id,check:true,result}}});};
 add('a',{protocol:2,action:'event',next:6}); add('b',parse());
 assert.equal(derive(chat,st,settings).total,2); assert.equal(derive(chat,st,settings).lastChange.round,2);
 const m=chat[3]; m.swipe_id=0; m.swipe_info=[{extra:structuredClone(m.extra)},{extra:{[KEY]:{epoch:st.epoch,turn:'b',check:true,result:parse(hold)}}}];
 m.swipe_id=1; assert.equal(derive(chat,st,settings).lastChange,null); assert.equal(derive(chat,st,settings).noProgressChecks,1);
 m.swipe_id=0; assert.equal(derive(chat,st,settings).lastChange.round,2);
 const copy=JSON.parse(JSON.stringify({chat,st})); assert.deepEqual(derive(copy.chat,copy.st,settings),derive(chat,st,settings));
 assert.equal(derive(chat,st,settings,'b').story,null);
 chat.splice(2); assert.equal(derive(chat,st,settings).story,null); assert.equal(derive(chat,st,settings).interval,6);
 assert.equal(derive(chat,st,{...settings,adaptive:false,interval:9}).interval,9);
 assert.equal(derive(chat,freshState(settings),settings).total,0);
});
test('legacy reports and absent reports are not presented as proven lack of progress',()=>{
 assert.match(describeResult({protocol:2,action:'event'}),/旧版/);
 assert.match(describeResult(parse({effect:''})),/不代表正文一定没有推进/);
});
test('prompt carries short memory and explicitly covers agency, surprises and limits',()=>{
 const v={history:[rec(parse(),1)],...storyView([rec(parse(),1)],3)};
 const p=buildPrompt(settings,{},v,'ticket');
 for(const term of ['意外与世界自主变化','角色主动','跨多轮','不升级灾难','重大危机关闭','上次报告的实质变化','协商合作','RPDIR:ticket']) assert.ok(p.includes(term),term);

});


test('text report survives an HTML-comment filter; old comments remain readable',()=>{
 const body=`${prose}\n[[RPDIR:ticket]]\n${JSON.stringify(base)}\n[[/RPDIR]]`;
 const filtered=body.replace(/<!--[\s\S]*?-->/g,'');
 assert.ok(advances(parseStatus(filtered,'ticket',settings)));
 assert.equal(stripStatus(body),prose);
 assert.equal(stripStatus(`${prose}\n[[RPDIR:ticket]] {"phase":`),prose);
 assert.ok(advances(parse()));
});
test('optional metadata and harmless format deviations do not erase real reports',()=>{
 const r={...base,protocol:undefined,source:undefined,dimension:undefined,surprise:undefined,next:undefined,level:'1'};
 const d={}; const parsed=parseStatus(`${prose}\n[[RPDIR:ticket]]\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n[[/RPDIR]]`,'ticket',settings,[],d);
 assert.ok(advances(parsed)); assert.equal(parsed.source,'unknown'); assert.equal(parsed.dimension,'unknown'); assert.equal(d.code,'ok');
 assert.equal(parse({surprise:'false',next:'8'}).surprise,false);
 assert.ok(parse({effect:undefined,dimension:undefined}).rejected);
});
test('diagnostics separate missing, truncated, wrong nonce, bad JSON and bad fields',()=>{
 for(const [body,expected] of [[prose,'missing'],[prose+'[[RPDIR:ticket]]{}','incomplete'],['[[RPDIR:old]]{}[[/RPDIR]]','nonce_mismatch'],['[[RPDIR:ticket]]oops[[/RPDIR]]','invalid_json'],[`[[RPDIR:ticket]]${JSON.stringify({...base,phase:'bogus'})}[[/RPDIR]]`,'invalid_fields']]){
  const d={};assert.equal(parseStatus(body,'ticket',settings,[],d),null);assert.equal(d.code,expected);
 }
});
test('old repeated failures back off immediately, successful report resets and swipes recalculate',()=>{
 const st=freshState(settings),chat=[];
 const add=(id,result)=>chat.push({is_user:true,mes:'继续',extra:{[KEY]:{epoch:st.epoch,id}}},{mes:prose,extra:{[KEY]:{epoch:st.epoch,turn:id,check:true,result}}});
 add('a',null);assert.equal(derive(chat,st,settings).interval,2);
 add('b',null);assert.equal(derive(chat,st,settings).interval,4);
 add('c',null);assert.equal(derive(chat,st,settings).interval,8);
 add('d',parse({effect:''}));assert.equal(derive(chat,st,settings).failureChecks,4);
 assert.equal(derive(chat,st,settings).interval,8);
 add('e',parse());assert.equal(derive(chat,st,settings).failureChecks,0);
 add('f',null);assert.equal(derive(chat,st,settings).interval,2);
 chat.splice(-4);assert.equal(derive(chat,st,settings).failureChecks,4);
 assert.equal(derive(chat,st,{...settings,adaptive:false,interval:5}).interval,5);
 assert.equal(derive(chat,freshState(settings),settings).failureChecks,0);
});
test('omitted optional memory preserves prior facts while explicit empty fields clear them',()=>{
 const old=parse(); const partial=parse({...hold,thread:undefined,goal:undefined,open:undefined,after:undefined});
 const v=storyView([rec(old,1),rec(partial,2)],2);
 assert.equal(v.story.goal,old.goal); assert.equal(v.story.open,old.open);assert.equal(v.story.situation,old.after);
 const clear=parse({...hold,goal:'',open:''});const w=storyView([rec(old,1),rec(clear,2)],2);assert.equal(w.story.goal,'');assert.equal(w.story.open,'');
});

