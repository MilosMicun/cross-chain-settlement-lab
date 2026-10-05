#!/usr/bin/env python3
"""Deploy and verify one disposable, runner-owned loopback EVM fixture."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def check_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # Allow closed HTTP sockets in TIME_WAIT, but reject any live listener.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", 18545))
        probe.listen(1)


def rpc(method):
    request = urllib.request.Request(
        "http://127.0.0.1:18545",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": []}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with http.open(request, timeout=2) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(f"{method}: {result['error']}")
    return result["result"]


def start(command, name, env=None):
    handle = (runtime / f"{name}.log").open("wb")
    handles.append(handle)
    process = subprocess.Popen(
        command, cwd=root, env=env, stdout=handle, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    processes.append(process)
    evidence.setdefault("ownedProcessGroups", []).append({"name": name, "pid": process.pid})
    return process


def group_exists(process):
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_owned(process):
    # The session belongs exclusively to this runner, including descendants
    # that remain alive after npm or the node process leader exits.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        process.poll()  # Reap the leader before checking for remaining descendants.
        if not group_exists(process):
            break
        time.sleep(0.1)
    if group_exists(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=5)
    deadline = time.monotonic() + 5
    while group_exists(process) and time.monotonic() < deadline:
        time.sleep(0.1)
    if group_exists(process):
        raise RuntimeError(f"Owned process group {process.pid} survived cleanup")


def ready(anvil):
    deadline = time.monotonic() + 30
    last_error = "not attempted"
    while time.monotonic() < deadline:
        if anvil.poll() is not None:
            raise RuntimeError(f"Anvil exited before readiness: {anvil.returncode}")
        try:
            chain_id = int(rpc("eth_chainId"), 16)
            break
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as error:
            last_error = str(error)
        time.sleep(0.2)
    else:
        raise RuntimeError(f"Anvil readiness deadline exceeded: {last_error}")
    block = int(rpc("eth_blockNumber"), 16)
    if chain_id != 31337 or block != 0:
        raise RuntimeError(f"Expected fresh chain 31337 at block zero; got {chain_id}, {block}")
    return {"chainId": str(chain_id), "initialBlockNumber": str(block)}


def released_port():
    deadline = time.monotonic() + 10
    while True:
        try:
            check_port()
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Port 18545 was not released after owned-process cleanup")
            time.sleep(0.2)


def interrupted(signum, _frame):
    raise RuntimeError(f"Interrupted by signal {signum}")


if sys.argv[1:]:
    raise SystemExit("This runner accepts no arguments")
root = Path(os.environ["LAB_ROOT"])
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
processes = []
handles = []
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# Occupancy fails before runtime creation or connection to any existing node.
check_port()
(root / ".runtime").mkdir(exist_ok=True)
runtime = Path(tempfile.mkdtemp(prefix="evm-deployment-", dir=root / ".runtime"))
evidence = {"runtimeDirectory": str(runtime.relative_to(root)), "rpcUrl": "http://127.0.0.1:18545"}
failures = []
print(f"Runtime: {runtime.relative_to(root)}", flush=True)
try:
    check_port()
    anvil = start([
        "anvil", "--silent", "--host", "127.0.0.1", "--port", "18545", "--chain-id", "31337",
    ], "anvil")
    evidence["anvilPid"] = anvil.pid
    evidence["initialState"] = ready(anvil)
    print("PASS: owned fresh Anvil, chain ID 31337, initial block zero", flush=True)
    env = os.environ.copy()
    env["EVM_DEPLOYMENT_RUNTIME"] = str(runtime)
    tests = start(["npm", "--prefix", "harness", "run", "test:evm-deployment"], "tests", env)
    deadline = time.monotonic() + 180
    while tests.poll() is None:
        if anvil.poll() is not None:
            raise RuntimeError(f"Anvil exited during tests: {anvil.returncode}")
        if time.monotonic() >= deadline:
            raise RuntimeError("Deployment tests exceeded the 180-second deadline")
        time.sleep(0.2)
    print((runtime / "tests.log").read_text(), flush=True)
    evidence["testExitCode"] = tests.returncode
    if tests.returncode != 0:
        raise RuntimeError(f"Deployment tests failed: {tests.returncode}")
    if anvil.poll() is not None:
        raise RuntimeError(f"Anvil exited unexpectedly after tests: {anvil.returncode}")
    for name in ("deployment-manifest.json", "deployment-evidence.json"):
        if not (runtime / name).is_file():
            raise RuntimeError(f"Missing public setup output: {name}")
    evidence["finalBlockNumber"] = str(int(rpc("eth_blockNumber"), 16))
except Exception as error:
    failures.append(str(error))
finally:
    if processes and processes[0].poll() is not None:
        failures.append(f"Owned Anvil exited before cleanup: {processes[0].returncode}")
    # Attempt every owned group even if another group's cleanup fails.
    cleanup_failures = []
    for process in reversed(processes):
        try:
            stop_owned(process)
        except Exception as error:
            cleanup_failures.append(str(error))
    for handle in handles:
        handle.close()
    evidence["ownedProcessesStopped"] = not cleanup_failures
    try:
        if processes:
            released_port()
            evidence["portReleased"] = True
            if not cleanup_failures:
                print("PASS: owned process groups stopped; port 18545 released", flush=True)
            else:
                print("PASS: port 18545 released; process-group cleanup reported failures", flush=True)
    except Exception as error:
        cleanup_failures.append(str(error))
        evidence["portReleased"] = False
    failures.extend(cleanup_failures)
    evidence["failures"] = failures
    (runtime / "runner-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Logs and public evidence preserved: {runtime.relative_to(root)}", flush=True)
if failures:
    raise SystemExit("FAIL: " + "; ".join(failures))
