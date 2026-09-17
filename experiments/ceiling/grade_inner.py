"""
Runs inside the grading container. Reads one JSON program per line on stdin,
writes one JSON verdict per line on stdout.

Each program runs as its own subprocess with a wall-clock timeout, so a task
that hangs or crashes the interpreter costs one verdict rather than the batch.
The container itself is the security boundary (--network none, non-root,
dropped capabilities); the subprocess is the reliability boundary.
"""
import json, subprocess, sys, tempfile, os, resource

TIMEOUT_S = 15

def limit():
    # A generated solution that allocates without bound should fail, not take
    # the host down with it. Memory is capped per process rather than per
    # container so one task cannot starve the rest of the batch.
    resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    item = json.loads(line)
    verdict = {"id": item["id"]}

    with tempfile.TemporaryDirectory() as work:
        path = os.path.join(work, "program.py")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(item["program"])
        try:
            done = subprocess.run(
                [sys.executable, path],
                cwd=work,
                capture_output=True,
                timeout=TIMEOUT_S,
                preexec_fn=limit,
            )
            verdict["pass"] = done.returncode == 0
            verdict["code"] = done.returncode
            if done.returncode != 0:
                verdict["stderr"] = done.stderr.decode("utf-8", "replace")[-600:]
        except subprocess.TimeoutExpired:
            verdict["pass"] = False
            verdict["code"] = "timeout"

    sys.stdout.write(json.dumps(verdict) + "\n")
    sys.stdout.flush()
