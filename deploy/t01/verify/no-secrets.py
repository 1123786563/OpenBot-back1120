#!/usr/bin/env python3
"""Scan delivered/client artifacts against actual private values; never output values."""
import json
import os
import pathlib
import re
import subprocess

root = pathlib.Path('.')
private = [root / 'deploy/t01/.env.t01', pathlib.Path(os.environ.get('T01_INTELLIGENCE_ENV', '~/.agentflow-runner-t01/intelligence.env')).expanduser()]
values = set()
for file in private:
    assert file.stat().st_mode & 0o077 == 0, 'Private configuration permission check failed'
    for line in file.read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        name, value = line.split('=', 1)
        if re.search(r'SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY', name):
            value = value.strip().strip('"\'')
            if len(value) >= 8:
                values.add(value)
values.update(json.loads((root / 'deploy/t01/.runtime/casdoor-users').read_text()).values())
files = {p for p in (root / 'app/dist').rglob('*') if p.is_file()}
for args in [['git', 'diff', '--name-only', 'HEAD'], ['git', 'ls-files', '--others', '--exclude-standard']]:
    for name in subprocess.check_output(args, text=True).splitlines():
        p = root / name
        if p.is_file():
            files.add(p)
files.add(root / '../implementation.md')
hits = []
for p in files:
    content = p.read_bytes()
    if any(value.encode() in content for value in values):
        hits.append(str(p))
result = {'passed': not hits, 'privateValuesChecked': len(values), 'artifactFilesChecked': len(files), 'filesWithSecrets': hits}
(root / 'deploy/t01/.runtime/secret-scan-final.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
assert not hits, 'Delivered artifact contains private value'
