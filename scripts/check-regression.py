#!/usr/bin/env python3
"""Supervise the existing regression commands without interpreting protocol evidence."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
OFFLINE_TESTS = (
    "protocol-encoding", "solana-configuration", "source-order",
    "source-cancellation", "source-recovery", "terminal-observation",
    "terminal-discovery", "recovery-plan", "recovery-observation",
    "cancellation-forwarding", "cancelled-delivery", "filled-delivery-recovery",
)
# Each tuple is (wrapper suffix, deadline seconds, suites already run by it).
# These are wrapper prerequisites as well as scenario suites. Repeated suites
# remain visible here; no extra standalone RPC suites or aggregate counts.
LIVE_STAGES = (
    ("evm-deployment", 300, ("evm-deployment",)),
    ("solana-deployment", 900, ("solana-deployment",)),
    ("solana-filled", 3900, ("initialization", "order-creation", "order-cancellation", "filled-settlement")),
    ("solana-cancelled", 2100, ("initialization", "cancelled-settlement")),
    ("solana-filled-rollback", 3300, ("initialization", "filled-rollback")),
    ("solana-cancelled-rollback", 3300, ("initialization", "cancelled-rollback")),
    ("filled-delivery", 2000, ("dual-chain-setup", "order-forwarding", "filled-delivery")),
    ("cancelled-delivery", 2000, ("dual-chain-setup", "cancellation-forwarding-live", "cancelled-delivery-live")),
    ("execute-wins", 2000, ("dual-chain-setup", "order-forwarding", "execute-wins")),
    ("failed-execution-refund", 2000, ("dual-chain-setup", "failed-execution-refund")),
    ("terminal-observation", 2000, ("dual-chain-setup", "terminal-observation-live")),
    ("terminal-discovery", 2000, ("dual-chain-setup", "terminal-discovery-live")),
    ("recovery-observation", 2000, ("dual-chain-setup", "order-forwarding", "recovery-observation-live")),
    ("filled-recovery", 2000, ("dual-chain-setup", "order-forwarding", "filled-recovery-live")),
    ("cancelled-recovery", 2000, ("dual-chain-setup", "cancellation-forwarding-live", "cancelled-recovery-live")),
)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def inventory(offline):
    coverage = {f"{name}.test.ts": {"kind": "offline", "stages": [f"offline-{name}"],
                                    "selected": True} for name in OFFLINE_TESTS}
    for wrapper, _, tests in LIVE_STAGES:
        for name in tests:
            entry = coverage.setdefault(f"{name}.test.ts", {
                "kind": "live", "stages": [], "selected": not offline,
            })
            entry["stages"].append(f"check-{wrapper}")
    current = {path.name for path in (ROOT / "harness/src/tests").glob("*.test.ts")}
    unclassified, missing = current - coverage.keys(), coverage.keys() - current
    if unclassified or missing:
        raise ValueError(f"Test inventory mismatch: unclassified={sorted(unclassified)}; missing={sorted(missing)}")
    return dict(sorted(coverage.items()))


def stage_plan(offline):
    solc = str(ROOT / ".local/solc-0.8.30")
    # (name, command argv, cwd, deadline seconds, runner-owned cleanup)
    stages = [
        ("check-tools", ["bash", "scripts/check-tools.sh"], ROOT, 120, False),
        ("check-builds", ["bash", "scripts/check-builds.sh"], ROOT, 1800, False),
        ("rust-tests", ["cargo", "test", "--workspace", "--locked"], ROOT / "solana", 900, False),
        ("forge-lint", ["forge", "lint", "--use", solc, "--deny", "notes"], ROOT / "evm", 120, False),
        # Leave invariant runs/depth/fail_on_revert under the existing config.
        ("forge-tests", ["forge", "test", "--use", solc, "--fuzz-runs", "256"], ROOT / "evm", 900, False),
    ]
    stages.extend((f"offline-{name}", ["node", "--test", "--test-concurrency=1",
                   "--test-isolation=none", f"src/tests/{name}.test.ts"],
                   ROOT / "harness", 120, False) for name in OFFLINE_TESTS)
    if not offline:
        stages.extend((f"check-{name}", ["bash", f"scripts/check-{name}.sh"],
                       ROOT, deadline, True) for name, deadline, _ in LIVE_STAGES)
    return stages


def current_evm_manifest(log, preexisting):
    # Only the successful current deployment's announcement supplies this path.
    # Never search/sort historical runtimes or replicate deployment validation.
    matches = re.findall(r"^Runtime: (\.runtime/evm-deployment-[A-Za-z0-9_-]+)$",
                         log.read_text(), re.MULTILINE)
    if len(matches) != 1:
        raise ValueError("EVM deployment must announce exactly one runtime")
    announced = ROOT / matches[0]
    runtime = announced.resolve()
    if (runtime != announced or runtime.parent != ROOT / ".runtime"
            or runtime.name in preexisting or not runtime.is_dir()):
        raise ValueError("EVM deployment did not announce a fresh runtime for this invocation")
    manifest = runtime / "deployment-manifest.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("Current successful EVM deployment has no deployment-manifest.json")
    return manifest


class Supervisor:
    def __init__(self):
        self.interruption = None
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, self.interrupted)

    def interrupted(self, signum, _frame):
        # Further signals must not interrupt the active runner's finally cleanup.
        if self.interruption is None:
            self.interruption = signum

    def run(self, command, cwd, log, deadline_seconds, runner=False):
        if self.interruption is not None:
            raise ValueError(f"Interrupted by signal {self.interruption} before stage launch")
        with log.open("wb") as handle:
            process = subprocess.Popen(command, cwd=cwd, stdout=handle,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + deadline_seconds
            stopped = None
            while process.poll() is None:
                if stopped is None and (self.interruption is not None or time.monotonic() >= deadline):
                    stopped = (f"Interrupted by signal {self.interruption}" if self.interruption is not None
                               else f"Stage exceeded {deadline_seconds}s deadline")
                    print(f"{stopped}; waiting for launched {'runner cleanup' if runner else 'processes'}.", flush=True)
                    try:
                        if runner:
                            # Wrappers exec the runner. Its detached node sessions
                            # belong to it: signal its PID once, then wait/reap.
                            # Existing readiness/test/cleanup bounds remain active.
                            process.terminate()
                        else:
                            os.killpg(process.pid, signal.SIGTERM)
                            try:
                                process.wait(timeout=15)
                            except subprocess.TimeoutExpired:
                                os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                time.sleep(0.1)
            code = process.wait()
        return code, stopped or (f"Interrupted by signal {self.interruption}" if self.interruption else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--offline", action="store_true", help="Run checks requiring no local RPC nodes")
    if sys.argv[1:] not in ([], ["--offline"], ["--help"], ["-h"]):
        parser.error("Invalid or conflicting arguments; use --help")
    args = parser.parse_args()
    supervisor = Supervisor()
    runtime_root = ROOT / ".runtime"
    runtime_root.mkdir(exist_ok=True)
    runtime = Path(tempfile.mkdtemp(prefix="regression-", dir=runtime_root))
    summary_path = runtime / "regression-summary.json"
    plan = stage_plan(args.offline)
    summary = {"schemaVersion": 1, "mode": "offline" if args.offline else "full",
               "status": "running", "completed": False, "startedAt": timestamp(),
               "requiredStages": [stage[0] for stage in plan], "stages": []}

    def persist():
        temporary = summary_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(summary, indent=2) + "\n")
        temporary.replace(summary_path)

    persist()
    print(f"Regression mode: {summary['mode']}; logs/summary: {runtime.relative_to(ROOT)}", flush=True)
    active = "inventory"
    try:
        if os.environ.get("LAB_ROOT") != str(ROOT):
            raise ValueError("Use bash scripts/check-regression.sh to select scripts/env.sh")
        summary["coverage"] = inventory(args.offline)
        persist()
        manifest = None
        for name, command, cwd, deadline, runner in plan:
            active = name
            if name == "check-solana-deployment":
                if manifest is None:
                    raise ValueError("No manifest from this invocation's successful EVM deployment")
                command = [*command, "--evm-manifest", str(manifest)]
            # Snapshot names only for provenance, never to select a manifest.
            preexisting = {path.name for path in runtime_root.iterdir()} if name == "check-evm-deployment" else set()
            log = runtime / f"{name}.log"
            record = {"name": name, "argv": command, "command": shlex.join(command),
                      "cwd": str(cwd.relative_to(ROOT)) or ".", "deadlineSeconds": deadline,
                      "log": str(log.relative_to(ROOT)), "status": "running", "exitCode": None,
                      "startedAt": timestamp()}
            summary["stages"].append(record)
            persist()
            print(f"Running {name}: {record['command']}; log: {record['log']}", flush=True)
            code, stopped = supervisor.run(command, cwd, log, deadline, runner)
            record.update(exitCode=code, status="passed" if code == 0 and not stopped else "failed",
                          finishedAt=timestamp())
            if stopped:
                record["failure"] = stopped
            persist()
            if code != 0 or stopped:
                raise ValueError(stopped or f"Stage exited {code}; see {record['log']}")
            if name == "check-evm-deployment":
                manifest = current_evm_manifest(log, preexisting)
                summary["evmManifest"] = str(manifest.relative_to(ROOT))
                persist()
        if supervisor.interruption is not None:
            raise ValueError(f"Interrupted by signal {supervisor.interruption}")
        summary.update(status="passed", completed=True, finishedAt=timestamp())
        persist()
        print(f"PASS: {summary['mode']} regression complete. Summary: {summary_path.relative_to(ROOT)}", flush=True)
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        if summary["stages"] and summary["stages"][-1]["name"] == active:
            summary["stages"][-1].update(status="failed", failure=str(error), finishedAt=timestamp())
        summary.update(status="failed", failedStage=active, failure=str(error), finishedAt=timestamp())
        persist()
        print(f"FAIL: {active}: {error}\nSummary/logs preserved: {summary_path.relative_to(ROOT)}", flush=True)
        return 128 + supervisor.interruption if supervisor.interruption else 1


if __name__ == "__main__":
    raise SystemExit(main())
