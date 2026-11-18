import json,subprocess,concurrent.futures,pathlib
repo='1123786563/OpenBot'
s=json.loads(pathlib.Path('.scratch/astryx-tickets/published.json').read_text())
def api(p):return json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/{p}'],text=True))
children=api('issues/40/sub_issues?per_page=100')
assert {v['number'] for v in s.values()} <= {c['number'] for c in children}
def check(item):
    k,v=item
    issue=api(f"issues/{v['number']}")
    assert 'ready-for-agent' in [l['name'] for l in issue['labels']]
    assert '## Acceptance criteria' in issue['body'] and 'Part of #40' in issue['body']
    deps=api(f"issues/{v['number']}/dependencies/blocked_by?per_page=100")
    assert {d['number'] for d in deps}=={s[str(d)]['number'] for d in v['deps']},(k,deps)
    return len(deps)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    edges=sum(pool.map(check,s.items()))
print(f'Verified {len(s)} child issues, labels and acceptance sections; {edges} native blocking edges.')
