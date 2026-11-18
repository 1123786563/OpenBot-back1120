#!/usr/bin/env python3
"""Observe actual Docker state after the public stop API, without issuing stop itself."""
import argparse, json, subprocess, time
p = argparse.ArgumentParser()
p.add_argument("--a", required=True)
p.add_argument("--b", required=True)
args = p.parse_args()
for name in (args.a, args.b):
    if not name.startswith("openbot-t01-computer-person-"):
        p.error("Only dedicated T01 per-person computers may be observed")
def state(name):
    r = subprocess.run(["docker", "inspect", "--format", "{{json .State}}", name], capture_output=True, text=True, check=True)
    s = json.loads(r.stdout)
    return {"running": s["Running"], "pid": s["Pid"]}
start = time.monotonic()
samples = []
for n in range(31):
    a, b = state(args.a), state(args.b)
    assert not a["running"] and a["pid"] == 0, "A resurrected or still has a running process"
    assert b["running"], "B was affected"
    samples.append({"second": round(time.monotonic()-start,2), "a": a, "b": b})
    if n < 30:
        time.sleep(2)
print(json.dumps({"passed": True, "samples": samples, "durationSeconds": round(time.monotonic()-start,2)}))
