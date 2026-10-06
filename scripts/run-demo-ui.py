#!/usr/bin/env python3
"""Present the existing local recovery runners and their validated public evidence."""

import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import textwrap
import time
import tty


ROOT = Path(__file__).resolve().parent.parent
CHOICES = (
    ("filled", "Filled settlement and recovery"),
    ("cancelled", "Cancelled refund and recovery"),
    ("both", "Both scenarios"),
    ("exit", "Exit"),
)
PURCHASE_EXPLANATION = (
    "User cash stays in Solana escrow.",
    "The executor funds an EVM purchase with its own liquidity.",
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


def filled_walkthrough(result):
    """Review verified current-run snapshots, never synthesize live progress."""
    demo = existing_demo()
    demo.require(result["status"] == "passed" and result["recoveredTerminalOutcome"] == "Filled",
                 "A Filled walkthrough requires a validated successful result")
    runtime = ROOT / result["freshDeployment"]
    forwarding = demo.load_public(runtime / "order-forwarding-evidence.json")
    recovery = demo.load_public(runtime / "filled-recovery-live-evidence.json")
    stages = recovery["stages"]
    creation = forwarding["stages"]["creation"]
    purchase = forwarding["stages"]["purchase"]
    destination = purchase["economics"]["state"]
    cancellation = stages["cancellation"]
    resumed, complete = (attempt["output"] for attempt in recovery["attempts"][1:])
    observed = resumed["observation"]["destination"]["observation"]
    cash = stages["independentExpectations"]["terms"]["cashAmount"]
    shares = observed["receipt"]["filledQuantity"]
    locked = creation["economics"]
    before_purchase = forwarding["stages"]["beforeExecution"]["state"]["balances"]
    demo.require(creation["state"] == "Pending" and creation["cancellationRequested"] is False and
                 locked["escrow"] == cash and locked["counters"] == [cash, "0", "0", "0"],
                 "Missing finalized deposit/locked-cash evidence")
    demo.require(destination["record"]["status"] == "1" and destination["record"]["filledQuantity"] == shares and
                 destination["balances"]["yes"]["holders"]["settlement"] == shares and
                 int(before_purchase["usd"]["holders"]["executor"]) -
                 int(destination["balances"]["usd"]["holders"]["executor"]) == int(cash) and
                 purchase["submissionHash"] == result["originalEvmTerminalTransactionHash"] and
                 purchase["receipt"]["status"] == 1 and purchase["additionalBlocks"] >= 2,
                 "Missing executor-funded confirmed purchase/custody evidence")
    after_purchase = forwarding["stages"]["sourceAfterPurchase"]
    demo.require(after_purchase["economics"] == locked and after_purchase["receiptDelivered"] is False and
                 after_purchase["exactStateUnchanged"] is True and
                 cancellation["before"]["state"]["economics"] == locked ==
                 cancellation["after"]["state"]["economics"] and
                 creation["finalizedSlot"] < cancellation["finalizedSlot"] < int(result["finalizedSolanaDeliverySlot"]),
                 "Missing purchase-before-cancellation evidence with cash still locked")
    # The runner's cancellation fixture starts after the confirmed forwarding
    # purchase; recovery independently re-observes its unchanged terminal record.
    demo.require(resumed["observation"]["source"]["state"] == "CancelRequested" and
                 resumed["observation"]["source"]["cancellationRequested"] is True and
                 observed["kind"] == "Confirmed" and observed["receipt"]["terminal"] == 1 and
                 observed["transactionHash"] == purchase["submissionHash"] and
                 resumed["observation"]["plan"]["kind"] == "DeliverFilled",
                 "Missing confirmed Filled outcome after user cancellation")
    demo.require(all(set(attempt["stdin"]) == {"user", "nonce", "minFinalizedSlot", "fromBlock", "toBlock"}
                     for attempt in recovery["attempts"]) and
                 len({attempt["processId"] for attempt in recovery["attempts"]}) == 3 and
                 any(read["method"] == "eth_getLogs" for read in resumed["recoveryReads"]["destination"]),
                 "Recovery must use fresh processes and chain discovery without a supplied terminal hash")
    final = complete["observation"]["source"]
    demo.require(final["state"] == result["finalSourceState"] == "Settled" and
                 final["cancellationRequested"] is True and
                 result["accountingBaseUnits"]["reimbursed"] == cash and
                 result["accountingBaseUnits"]["issued"] == shares and
                 complete["observation"]["plan"]["kind"] == "Complete" and
                 complete["submissionCount"] == complete["signingCount"] == 0 and
                 recovery["attempts"][2]["unchanged"] is True,
                 "Missing settlement, preserved cancellation history or read-only completion")
    compact_cash = amount(cash).rstrip("0").rstrip(".")
    compact_shares = amount(shares).rstrip("0").rstrip(".")
    return [
        ("USER DEPOSIT", [f"The user locks {compact_cash} mock USD in Solana escrow.",
                          "This deposit is not transferred to EVM."],
         [f"Source lifecycle: {creation['state']}", f"Escrow cash: {amount(locked['escrow'])} mock USD"]),
        ("EXECUTOR PURCHASE", [f"The executor buys {compact_shares} mock YES with its own EVM cash.",
                               "The position stays in Settlement custody."],
         ["Destination outcome: Filled", f"Executor cash spent: {amount(cash)} mock USD",
          f"Settlement custody: {amount(shares)} mock YES"]),
        ("CANCELLATION RACE", ["The user requests cancellation after EVM execution.",
                               "The destination outcome remains Filled."],
         [f"Source lifecycle: {resumed['observation']['source']['state']}", "Destination outcome: Filled"]),
        ("RECOVERY", ["A fresh application process rediscovers confirmed Filled.",
                      "Chain reads use no prior in-memory decision or supplied transaction hash."],
         [f"EVM observation: {observed['kind']}",
          f"Recovery decision: {resumed['observation']['plan']['kind']}"]),
        ("SOURCE SETTLEMENT", [f"Solana issues {compact_shares} mock YES to the user.",
                               f"The executor receives {compact_cash} mock USD from source escrow."],
         [f"Source lifecycle: {final['state']}", f"Cancellation requested: {final['cancellationRequested']}"]),
        ("COMPLETION", ["The next process observes Complete without submitting a transaction.",
                        "This is a chain observation, not an on-chain replay."],
         [f"Recovery decision: {complete['observation']['plan']['kind']}",
          f"Further submissions: {complete['submissionCount']}"]),
    ]


def walkthrough_rows(step):
    heading, explanation, values = step
    return ["Review of this completed, validated run.", "", heading, "", *explanation,
            "", "", "Verified values:", *values]


def exit_status(code):
    return code if code >= 0 else 128 - code


class TerminalInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum
        super().__init__(f"Interrupted by signal {signum}")


@contextmanager
def keyboard():
    """Use cbreak only while reading UI keys, preserving signals and echo elsewhere."""
    fd = sys.stdin.fileno()
    settings = termios.tcgetattr(fd)
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}

    def interrupted(signum, _frame):
        raise TerminalInterrupted(signum)

    try:
        for sig in handlers:
            signal.signal(sig, interrupted)
        tty.setcbreak(fd)
        print("\033[?25l", end="", flush=True)
        yield fd
    finally:
        # Restore input first, including on EOF, rendering errors, or a signal.
        try:
            termios.tcsetattr(fd, termios.TCSADRAIN, settings)
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            print("\033[?25h", end="", flush=True)


def read_key(fd):
    """Decode arrow keys with a bounded escape-sequence wait; accept both TTY forms."""
    sequences = {b"\x1b[" + suffix: name for suffix, name in
                 ((b"A", "up"), (b"B", "down"), (b"C", "right"), (b"D", "left"))}
    sequences.update({key.replace(b"[", b"O"): value for key, value in list(sequences.items())})
    data = os.read(fd, 1)
    if not data:
        raise ValueError("Terminal input closed during navigation")
    if data == b"\x1b":
        deadline = time.monotonic() + 0.15
        while any(key.startswith(data) for key in sequences):
            if data in sequences:
                return sequences[data]
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                break
            part = os.read(fd, 1)
            if not part:
                raise ValueError("Terminal input closed during navigation")
            data += part
        return "escape"
    if data in (b"\r", b"\n"):
        return "enter"
    return data.decode("ascii", errors="ignore").lower()


class Terminal:
    def __init__(self, no_color=False, automatic=False):
        capable = sys.stdout.isatty() and os.environ.get("TERM", "dumb") != "dumb"
        self.color = capable and not no_color and "NO_COLOR" not in os.environ
        self.animated = self.color
        self.interactive = self.color and sys.stdin.isatty() and not automatic

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

    def welcome(self):
        self.line(self.styled("CROSS-CHAIN  /  SETTLEMENT LAB", "1;36"))
        self.line("Local mock-token demo • Trusted operator/RPC")

    def screen(self, title, rows, footer, offset=0, emphasis=()):
        """Page long content instead of clipping paths or monetary fields on small TTYs."""
        columns, height = shutil.get_terminal_size((80, 24))
        width = max(12, columns - 2)
        content = [(part, "1;33" if row in emphasis else
                    "2" if row in ("Review of this completed, validated run.", "Verified values:") else
                    "1;32" if row.startswith(("Source lifecycle:", "Destination outcome:", "Escrow cash:",
                                              "Executor cash spent:", "Settlement custody:", "Recovery decision:",
                                              "EVM observation:", "Cancellation requested:", "Further submissions:")) else None)
                   for row in rows for part in
                   (textwrap.wrap(row, width=width, subsequent_indent="  ") or [""])]
        heading = ["CROSS-CHAIN  /  SETTLEMENT LAB", "Local mock-token demo • Trusted operator/RPC", "", title]
        heading = [part for row in heading for part in (textwrap.wrap(row, width) or [""])]
        controls = [part for row in footer for part in textwrap.wrap(row, width)]
        capacity = max(1, height - len(heading) - len(controls) - 3)
        offset = min(max(0, offset), max(0, len(content) - capacity))
        print("\033[2J\033[H", end="", flush=True)
        for index, row in enumerate(heading):
            self.line(self.styled(row, "1;36" if index == 0 else "1;32")
                      if index == 0 or row == title else row)
        self.line()
        visible = content[offset:offset + capacity]
        for row, style in visible:
            if style:
                row = self.styled(row, style)
            else:
                row = re.sub(r"\b(?:[0-9]+(?:\.[0-9]+)? mock (?:USD|YES)|Pending|Filled|"
                             r"CancelRequested|Settled|Complete)\b",
                             lambda match: self.styled(match[0], "1;32"), row)
            self.line(" " + row)
        # Keep controls at the bottom; story spacing stays stable across steps.
        for _ in range(capacity - len(visible)):
            self.line()
        self.line(self.styled(f"Lines {offset + 1}-{min(offset + capacity, len(content))} of {len(content)}"
                              " • Up/Down to scroll", "2"))
        for row in controls:
            self.line(self.styled(row, "2"))
        return offset

    def select(self):
        if self.interactive:
            selected = 0
            with keyboard() as fd:
                while True:
                    print("\033[2J\033[H", end="", flush=True)
                    self.welcome()
                    self.line(self.styled("\nLOCAL RUN / SELECT SCENARIO", "1;33"))
                    self.line("Separate fresh deployments • Real mock-token execution\n")
                    for row in PURCHASE_EXPLANATION:
                        self.line(row)
                    self.line()
                    for index, (_, label) in enumerate(CHOICES):
                        row = (" > " if index == selected else "   ") + f"[{index + 1:02}] {label} "
                        self.line(self.styled(row, "1;30;43") if index == selected else row)
                    self.line(self.styled("\nUp/Down: choose • Enter: run • Ctrl+C: exit", "2"))
                    key = read_key(fd)
                    if key in ("up", "down"):
                        selected = (selected + (1 if key == "down" else -1)) % len(CHOICES)
                    elif key == "enter":
                        print("\033[2J\033[H", end="", flush=True)
                        self.welcome()
                        self.line("\nSelected local demo: " + CHOICES[selected][1])
                        return CHOICES[selected][0]
        self.welcome()
        self.line()
        for row in PURCHASE_EXPLANATION:
            self.line(row)
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

    def result_rows(self, result):
        explanation = {
            "Filled": [
                "User receives mock YES on Solana.",
                "Executor receives reimbursement from source escrow.",
            ],
            "Cancelled": [
                "Confirmed EVM cancellation and the user's cancellation request permit the source refund.",
                "No YES is issued.",
            ],
        }[result["recoveredTerminalOutcome"]]
        rows = [
            "Outcome and recovery:",
            *explanation,
            "Fresh application processes recover the outcome from chain state.",
            "Complete means no further submissions.",
            "",
            "Verified chain results:",
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
        ])
        return rows

    def evidence_rows(self, result):
        rows = [
            "Public evidence (full transaction identifiers included):",
            "Order ID: " + result["orderId"],
            "Original EVM terminal transaction: " + result["originalEvmTerminalTransactionHash"],
            "Finalized Solana delivery: " + result["solanaDeliverySignature"],
            *["  " + path for path in result["publicEvidence"]],
            "Runner log: " + result["logs"][0],
        ]
        if result["recoveredTerminalOutcome"] == "Filled":
            demo = existing_demo()
            runtime = ROOT / result["freshDeployment"]
            forwarding = demo.load_public(runtime / "order-forwarding-evidence.json")
            recovery = demo.load_public(runtime / "filled-recovery-live-evidence.json")
            rows.extend(["", "Walkthrough details:",
                         f"Finalized deposit slot: {forwarding['stages']['creation']['finalizedSlot']}",
                         f"Finalized cancellation slot: {recovery['stages']['cancellation']['finalizedSlot']}"])
            for attempt in recovery["attempts"]:
                output = attempt["output"]
                rows.append(f"Application process {output['processId']}: {output['observation']['plan']['kind']}; "
                            f"submissions={output['submissionCount']}")
        return rows

    def result(self, result):
        if result["recoveredTerminalOutcome"] == "Filled":
            for number, step in enumerate(filled_walkthrough(result), 1):
                self.card(f"VERIFIED WALKTHROUGH / Filled • Step {number} / 6", walkthrough_rows(step))
        self.card("VERIFIED / " + result["recoveredTerminalOutcome"],
                  self.result_rows(result) + self.evidence_rows(result))

    def review(self, results, next_scenario, summary_path, supervisor):
        """Inspect each validated result before continuing, with a separate evidence view."""
        index = len(results) - 1
        stories = {number: filled_walkthrough(result) for number, result in enumerate(results)
                   if result["recoveredTerminalOutcome"] == "Filled"}
        story = index in stories
        step = 0
        evidence = False
        offset = 0
        with keyboard() as fd:
            while True:
                if supervisor.interruption is not None:
                    raise TerminalInterrupted(supervisor.interruption)
                result = results[index]
                if evidence:
                    title = "PUBLIC EVIDENCE / " + result["recoveredTerminalOutcome"]
                    rows = self.evidence_rows(result) + ["Public summary: " + str(summary_path.relative_to(ROOT)),
                                                        "", *self.result_rows(result)]
                    footer = ["E / Esc / Enter: back to " + ("walkthrough" if story else "result")]
                elif story:
                    title = f"VERIFIED WALKTHROUGH / Filled • Step {step + 1} / 6"
                    rows = walkthrough_rows(stories[index][step])
                    footer = ["Left/Right: story steps • E: public evidence • F: full result",
                              "Enter: " + ("next step" if step < 5 else "full result")]
                else:
                    title = "VERIFIED / " + result["recoveredTerminalOutcome"]
                    rows = self.result_rows(result)
                    footer = ["Left/Right: completed results • E: public evidence" +
                              (" • W: walkthrough" if index in stories else ""),
                              "Enter: " + (f"run {next_scenario} local demo" if next_scenario else "finish demo")]
                if not story or evidence:
                    title += f" • result {index + 1}/{len(results)}"
                emphasis = (stories[index][step][0],) if story and not evidence else ()
                offset = self.screen(title, rows, footer, offset, emphasis)
                key = read_key(fd)
                if key in ("up", "down"):
                    offset += 1 if key == "down" else -1
                elif evidence and key in ("e", "escape", "enter"):
                    evidence, offset = False, 0
                elif not evidence and key == "e":
                    evidence, offset = True, 0
                elif not evidence and story and key == "f":
                    story, offset = False, 0
                elif not evidence and not story and key == "w" and index in stories:
                    story, step, offset = True, 0, 0
                elif not evidence and story and key in ("left", "right", "enter"):
                    if key == "enter" and step == 5:
                        story = False
                    else:
                        step = min(max(0, step + (-1 if key == "left" else 1)), 5)
                    offset = 0
                elif not evidence and key in ("left", "right"):
                    index = min(max(0, index + (1 if key == "right" else -1)), len(results) - 1)
                    offset = 0
                elif not evidence and key == "enter":
                    print("\033[2J\033[H", end="", flush=True)
                    self.welcome()
                    return


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
               "Interactive TTY: arrows/Enter select; E opens evidence; Left/Right browse completed results. "
               "Requires the same pinned tools and Linux namespace permissions as run-demo.sh.")
    parser.add_argument("--scenario", choices=[choice[0] for choice in CHOICES],
                        help="Skip the menu and result pauses")
    parser.add_argument("--no-color", action="store_true",
                        help="Disable ANSI color; use the plain numbered menu without result pauses")
    args = parser.parse_args()
    terminal = Terminal(args.no_color, automatic=args.scenario is not None)
    try:
        if args.scenario:
            terminal.welcome()
        selection = args.scenario or terminal.select()
    except ValueError as error:
        terminal.line(f"ERROR: {error}")
        return 2
    except KeyboardInterrupt:
        terminal.line("\nInterrupted; no demo started.")
        return 130
    except TerminalInterrupted as error:
        terminal.line("\nInterrupted; no demo started.")
        return 128 + error.signum
    except (OSError, termios.error) as error:
        terminal.line(f"ERROR: Terminal navigation failed: {error}")
        return 1
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
                if terminal.interactive:
                    completed = len(summary["scenarios"])
                    next_scenario = scenarios[completed][2] if completed < len(scenarios) else None
                    terminal.review(summary["scenarios"], next_scenario, summary_path, supervisor)
                else:
                    terminal.result(result)
        if supervisor.interruption is not None:
            return failure("Interrupted before completion", 128 + supervisor.interruption)
        summary.update(status="passed", exitCode=0)
        persist()
        terminal.line(f"\nVerified {len(scenarios)} scenario(s). Public summary: {summary_path.relative_to(ROOT)}")
        return 0
    except TerminalInterrupted as error:
        return failure(str(error), 128 + error.signum)
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, OSError, termios.error) as error:
        return failure(f"Evidence/execution check failed: {error}", 1)


if __name__ == "__main__":
    raise SystemExit(main())
