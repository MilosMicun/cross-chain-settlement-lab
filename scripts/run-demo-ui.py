#!/usr/bin/env python3
"""Present the existing local recovery runners and their validated public evidence."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
CHOICES = (
    ("filled", "Filled settlement and recovery"),
    ("cancelled", "Cancelled refund and recovery"),
    ("both", "Both scenarios"),
    ("exit", "Exit"),
)


def existing_demo():
    # Keep evidence validation in the existing, verified demo implementation.
    spec = importlib.util.spec_from_file_location("local_demo", ROOT / "scripts/run-demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def amount(value):
    """Format unsigned base units with exactly six decimals, using integers only."""
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError("Expected an unsigned base-unit string")
    whole, fraction = divmod(int(value), 1_000_000)
    return f"{whole}.{fraction:06d}"


def exit_status(code):
    return code if code >= 0 else 128 - code


class Terminal:
    def __init__(self, no_color=False):
        capable = sys.stdout.isatty() and os.environ.get("TERM", "dumb") != "dumb"
        self.color = capable and not no_color and "NO_COLOR" not in os.environ
        self.animated = self.color

    def styled(self, text, style):
        return f"\033[{style}m{text}\033[0m" if self.color else text

    def line(self, text=""):
        print(text, flush=True)

    def card(self, title, rows):
        width = min(76, max(24, shutil.get_terminal_size((80, 24)).columns - 4))
        self.line()
        style = "1;31" if title.startswith("FAILED") else "1;32"
        self.line(self.styled("+ " + title + " " + "-" * max(0, width - len(title) - 3), style))
        for row in rows:
            self.line("  " + row if row else "")
        self.line(self.styled("+" + "-" * (width - 1), "2"))

    def select(self):
        self.line()
        for number, (_, label) in enumerate(CHOICES, 1):
            self.line(f"  {number}  {label}")
        while True:
            self.line()
            try:
                selected = input("Choose [1-4]: ").strip()
            except EOFError:
                raise ValueError("No selection received; use --scenario or choose 1-4") from None
            if selected in ("1", "2", "3", "4"):
                return CHOICES[int(selected) - 1][0]
            if not sys.stdin.isatty():
                raise ValueError("Invalid selection; choose 1-4")
            self.line("Invalid selection; choose 1-4.")

    def result(self, result):
        rows = [
            f"Terminal outcome: {result['recoveredTerminalOutcome']}",
            f"Source lifecycle: {result['finalSourceState']}",
            f"Separate fresh deployment: {result['freshDeployment']}",
            "",
            "Source SPL balances (mock tokens, six decimals):",
        ]
        for key, label in (("userCash", "User cash"), ("escrow", "Escrow cash"),
                           ("executorCash", "Executor cash"), ("userYes", "User YES")):
            token = "YES" if key == "userYes" else "USD"
            rows.append(f"{label}: {amount(result['sourceBalancesBaseUnits'][key])} mock {token}")
        rows.append("Accounting counters (mock tokens):")
        for key, value in result["accountingBaseUnits"].items():
            rows.append(f"  {key}: {amount(value)} mock {'YES' if key == 'issued' else 'USD'}")
        completion = result["recoveryCompletion"]
        rows.extend([
            "",
            f"Recovery decision: {completion['kind']}; further submissions={completion['furtherSubmissions']}",
            f"Finalized delivery slot: {result['finalizedSolanaDeliverySlot']}",
            f"Cleanup: owned processes stopped={result['cleanup']['ownedProcessesStopped']}; "
            f"ports released={result['cleanup']['portsReleased']}",
            "Public evidence (full transaction identifiers included):",
            *["  " + path for path in result["publicEvidence"]],
            "Runner log: " + result["logs"][0],
        ])
        self.card("VERIFIED / " + result["recoveredTerminalOutcome"], rows)


class Supervisor:
    def __init__(self, terminal):
        self.terminal = terminal
        self.interruption = None
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, self.interrupted)

    def interrupted(self, signum, _frame):
        if self.interruption is None:
            self.interruption = signum

    def run(self, script, log, timeout, runner=False):
        if self.interruption is not None:
            return 128 + self.interruption, "Interrupted before starting next stage"
        # Select the exact environment used by run-demo.sh without changing it.
        command = ["bash", "-c", 'source scripts/env.sh; export PATH="$PATH:$HOME/.foundry/bin"; '
                   'exec bash "$1"', "demo-ui", str(ROOT / "scripts" / script)]
        self.terminal.line(f"Running {script} | log: {log.relative_to(ROOT)}")
        with log.open("wb") as handle:
            process = subprocess.Popen(command, cwd=ROOT, stdout=handle,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + timeout
            stopped = None
            frame = 0
            while process.poll() is None:
                if stopped is None and (self.interruption is not None or time.monotonic() >= deadline):
                    stopped = (f"Interrupted by signal {self.interruption}" if self.interruption is not None
                               else f"{script} exceeded {timeout}s deadline")
                    if self.terminal.animated:
                        print("\r\033[2K", end="", flush=True)
                    self.terminal.line(stopped + "; waiting for " +
                                       ("runner cleanup." if runner else "build/tool processes."))
                    try:
                        if runner:
                            # Signal only the runner PID. Its finally owns all node cleanup.
                            process.terminate()
                        else:
                            os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    if not runner:
                        try:
                            process.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                if self.terminal.animated:
                    status = "Waiting for cleanup" if stopped else "Running"
                    marker = "|/-\\"[frame % 4]
                    print(f"\r\033[2K  {marker} {status}: {script}", end="", flush=True)
                    frame += 1
                time.sleep(0.1)
            code = process.wait()
        if self.terminal.animated:
            print("\r\033[2K", end="", flush=True)
        return exit_status(code), stopped


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, allow_abbrev=False,
        epilog="Builds existing artifacts; installs no tools. Both scenarios use separate fresh deployments. "
               "Logs/public evidence remain in .runtime/. On interruption, waits for runner cleanup. "
               "Requires the same pinned tools and Linux namespace permissions as run-demo.sh.")
    parser.add_argument("--scenario", choices=[choice[0] for choice in CHOICES],
                        help="Skip the numbered menu")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI color")
    args = parser.parse_args()
    terminal = Terminal(args.no_color)
    terminal.line(terminal.styled("Cross-chain settlement lab", "1;35"))
    terminal.line("Local mock-token demo • Trusted operator/RPC")
    try:
        selection = args.scenario or terminal.select()
    except ValueError as error:
        terminal.line(f"ERROR: {error}")
        return 2
    except KeyboardInterrupt:
        terminal.line("\nInterrupted; no demo started.")
        return 130
    if selection == "exit":
        terminal.line("Exited; no demo started.")
        return 0

    supervisor = Supervisor(terminal)
    demo = existing_demo()
    runtime_root = ROOT / ".runtime"
    runtime_root.mkdir(exist_ok=True)
    session = Path(tempfile.mkdtemp(prefix="demo-ui-", dir=runtime_root))
    summary_path = session / "ui-summary.json"
    summary = {"status": "running", "tokenDecimals": 6, "scenarios": [], "logs": {}}

    def persist():
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    def failure(message, code):
        summary.update(status="failed", failure=message, exitCode=code)
        persist()
        terminal.card("FAILED / incomplete run", [message, f"Exit code: {code}",
                      f"Logs and public summary: {session.relative_to(ROOT)}"])
        return code

    persist()
    terminal.line(f"Logs and public summary: {summary_path.relative_to(ROOT)}")
    try:
        stages = [("check-tools.sh", 120, False), ("check-builds.sh", 1800, False)]
        scenarios = [scenario for scenario in demo.SCENARIOS
                     if selection == "both" or scenario[0].startswith(selection + "-")]
        stages.extend((f"check-{scenario[0]}.sh", 2000, True) for scenario in scenarios)
        for script, timeout, runner in stages:
            log = session / (script.removesuffix(".sh") + ".log")
            summary["logs"][script] = str(log.relative_to(ROOT))
            persist()
            preexisting = {path.name for path in runtime_root.iterdir()}
            if runner:
                terminal.line("\nStarting a separate fresh local deployment.")
            code, stopped = supervisor.run(script, log, timeout, runner)
            if code != 0 or stopped or supervisor.interruption is not None:
                if runner:
                    try:
                        runtime = demo.runtime_from_log(log, preexisting)
                        summary["failedScenarioRuntime"] = str(runtime.relative_to(ROOT))
                        terminal.line(f"Active runner logs/public evidence: {runtime.relative_to(ROOT)}")
                    except ValueError:
                        pass
                # Preserve nonzero runner exit codes. A completed runner cannot erase interruption.
                failed_code = code or (128 + supervisor.interruption if supervisor.interruption else 1)
                return failure(stopped or f"{script} failed (exit {failed_code}); see {log.relative_to(ROOT)}",
                               failed_code)
            if runner:
                scenario = next(item for item in scenarios if script == f"check-{item[0]}.sh")
                result = demo.summarize(demo.runtime_from_log(log, preexisting), log, scenario, code)
                demo.require(all(result["freshDeployment"] != earlier["freshDeployment"]
                                 for earlier in summary["scenarios"]), "Expected separate fresh deployments")
                if supervisor.interruption is not None:
                    return failure("Interrupted during evidence validation", 128 + supervisor.interruption)
                summary["scenarios"].append(result)
                persist()
                terminal.result(result)
        if supervisor.interruption is not None:
            return failure("Interrupted before completion", 128 + supervisor.interruption)
        summary.update(status="passed", exitCode=0)
        persist()
        terminal.line(f"\nVerified {len(scenarios)} scenario(s). Public summary: {summary_path.relative_to(ROOT)}")
        return 0
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, OSError) as error:
        return failure(f"Evidence/execution check failed: {error}", 1)


if __name__ == "__main__":
    raise SystemExit(main())
