"""Link existing Bifrost work, update #61 index, and audit native relationships."""
import concurrent.futures
import json
import re
import runpy
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parent
REPO='1123786563/OpenBot'
STATE=ROOT/'billing-subtasks-publication.json'

def api(path):
    return json.loads(subprocess.check_output(['gh','api',path],text=True))

def post(path,payload):
    p=subprocess.run(['gh','api','--method','POST',path,'--input','-'],input=json.dumps(payload),text=True,capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr)

def replace_block(body,marker,block):
    pattern=r'\n?<!-- '+re.escape(marker)+r':start -->.*?<!-- '+re.escape(marker)+r':end -->\n?'
    body=re.sub(pattern,'',body,flags=re.S).rstrip()
    return body+'\n\n<!-- '+marker+':start -->\n'+block+'\n<!-- '+marker+':end -->\n'

def main():
    state=json.loads(STATE.read_text())
    tasks=runpy.run_path(str(ROOT/'publish-billing-subtasks.py'))['TASKS']
    assert len(state['issues'])==len(tasks)==20
    def num(k): return state['issues'][k]['number']
    extra=[num('T05'),num('T06')]
    current=api(f'repos/{REPO}/issues/32/dependencies/blocked_by?per_page=100')
    for n in extra:
        if n not in {x['number'] for x in current}:
            post(f'repos/{REPO}/issues/32/dependencies/blocked_by',{'issue_id':api(f'repos/{REPO}/issues/{n}')['id']})
    old=api(f'repos/{REPO}/issues/32')['body']
    note=f'''## 与 #61 生产账本的接入依赖

Blocked by: #{extra[0]}, #{extra[1]}

本票继续归属 #16，不复制为 #61 子票。生产账本预留/结算/释放及 root Run 上限由 #{extra[0]} 交付，真实个人 Billing Account 和可信付款上下文由 #{extra[1]} 交付；本票消费这两者，验证一次真实执行经 Bifrost 的不可绕过接入。

两项依赖验收完成后才进入本票正式接入验收；可提前阅读合同和准备供应商夹具，但不能用模拟余额关闭本票。两项账本票不依赖本票关闭，避免循环依赖。后续 #33–#39 仍负责模型请求、故障、辅助/后台、子代理与委派链路，本次不改变这些票的原验收条件。
'''
    p=ROOT/'billing-subtasks'/'existing-32.md';p.write_text(replace_block(old,'billing-ledger-dependencies',note))
    subprocess.run(['gh','issue','edit','32','--repo',REPO,'--body-file',str(p)],check=True,capture_output=True,text=True)

    startable={'T01':'可立即实施；无外部前置', 'T02':'可立即核查；商户配置缺失则不能关闭'}
    source={'T06','T15','T16','T17'}
    merchant={'T11','T18'}
    rows=[]
    for t in tasks:
        e=state['issues'][t['key']]
        deps='、'.join('#'+str(n) for n in e['dependencies']) or '无任务前置'
        if t['key'] in startable: status=startable[t['key']]
        elif t['key'] in merchant: status='依赖未完成；后端/真实商户联调关'
        elif t['key'] in source: status='依赖未完成；真实后端集成关'
        elif t['key']=='T19': status='依赖未完成；正式配置与恢复演练关'
        elif t['key']=='T20': status='依赖未完成；全部上线关卡'
        else: status='依赖完成后可隔离开发；不等同真实上线'
        rows.append(f"| #{e['number']} | {t['title']} | {deps} | {status} |")
    board=f'''## 实施子任务与阻塞关

已拆分 20 张子票，均标记 `ready-for-agent`，使用 GitHub 原生父子关系和 blocked-by 依赖；本表为发布时状态，后续以依赖票验收及原生状态为准。标签不表示外部条件已就绪。

| 子票 | 独立交付 | 直接阻塞任务 | 当前推进条件 |
| --- | --- | --- | --- |
'''+ '\n'.join(rows)+f'''

### 可立即推进

- #{num('T01')}：统一合同与集成测试边界，可在当前仓库独立完成。
- #{num('T02')}：商户产品/环境核查可以立即开始；缺产品权限、凭据注入或公网回调时必须保持未完成，不把配置清单当作环境可用。
- #{num('T01')} 完成后，#{num('T03')} 账本核心、#{num('T04')} 商品周期、#{num('T08')} 微信适配器、#{num('T09')} 支付宝适配器可并行；这些隔离模块不需要等待完整后端源码或真实交易。

### 复用既有工作，避免重复

- 后端来源及运行基线复用 #2/#18。历史提交可读不等于当前镜像可构建，不再新建“获取后端”子票；两条既有工作共享同一基线证据，保留各自身份/工具验权验收。
- 真实身份与空间初始化、邮箱稳定关联复用 #3/#4/#7，停用和恢复复用 #11/#12/#13，三端登录复用 #8/#9。新 #{num('T06')} 只实现账务账户绑定，不重做 Casdoor。
- #32 现已原生依赖 #{num('T05')} 和 #{num('T06')}；#33–#38 继续负责模型请求、故障、辅助后台及委派/子代理，不重新挂为本票子任务。#39 是模型矩阵验收，本票 #{num('T20')} 在其基础上验收实际购买、退款及对账。
- 新 #{num('T15')} 仅负责模型之外的收费工具/计算资源；#{num('T16')} 仅增加订阅配额与计费暂停规则，不替代既有身份停用机制。

### 完成与关闭规则

每张子票包含6–9项可观察验收条件和独立阻塞关，合计143项。所有直接前置票验收完成后才能进入正式实施；可以提前阅读和准备，不得以准备工作关闭受阻票。真实商户与生产配置的外部条件在对应票内显式列出，不额外用非规范标签替代依赖。

父规格只有20张子票均完成、复用的身份/模型验收通过、且 #{num('T20')} 记录全链路证据后才可关闭；不因为子票已发布或账本参考模型通过关闭父票。代码、模拟协议、商户实测及生产放行分别记录。
'''
    parent=api(f'repos/{REPO}/issues/61')
    p=ROOT/'billing-subtasks'/'parent-61.md';p.write_text(replace_block(parent['body'],'billing-subtask-index',board))
    subprocess.run(['gh','issue','edit','61','--repo',REPO,'--body-file',str(p)],check=True,capture_output=True,text=True)
    (ROOT/'billing-subtasks-index.md').write_text(board+'\n')

    # Audit every actual relationship, label and body, not merely tool exit codes.
    children=api(f'repos/{REPO}/issues/61/sub_issues?per_page=100')
    expected={e['number'] for e in state['issues'].values()}
    assert expected <= {x['number'] for x in children}
    def audit(t):
        e=state['issues'][t['key']];n=e['number']
        remote=api(f'repos/{REPO}/issues/{n}')
        deps=api(f'repos/{REPO}/issues/{n}/dependencies/blocked_by?per_page=100')
        assert remote['body'].replace('\r\n','\n').strip()==(ROOT/'billing-subtasks'/(t['key']+'.md')).read_text().strip()
        assert 'ready-for-agent' in {x['name'] for x in remote['labels']}
        assert set(e['dependencies'])=={x['number'] for x in deps}
        return n,[x['number'] for x in deps]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        graph=dict(pool.map(audit,tasks))
    pending={32,39}|{x for deps in graph.values() for x in deps if x not in graph}
    while pending:
        n=pending.pop()
        if n in graph:continue
        deps=api(f'repos/{REPO}/issues/{n}/dependencies/blocked_by?per_page=100')
        graph[n]=[x['number'] for x in deps]
        pending.update(x for x in graph[n] if x not in graph)
    assert set(extra) <= set(graph[32])
    visiting=set();visited=set()
    def visit(n):
        assert n not in visiting, f'dependency cycle at {n}'
        if n in visited:return
        visiting.add(n)
        for d in graph[n]:visit(d)
        visiting.remove(n);visited.add(n)
    for n in graph:visit(n)
    assert 'billing-subtask-index:start' in api(f'repos/{REPO}/issues/61')['body']
    state.update(verified=True,child_count=20,new_dependency_edges=sum(len(e['dependencies']) for e in state['issues'].values()),
                 added_existing_dependencies={'32':extra},acyclic=True)
    STATE.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'verified':True,'children':20,'new_dependency_edges':state['new_dependency_edges'],
                      'existing_bifrost_dependencies':extra,'cycle_check':'passed'},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
