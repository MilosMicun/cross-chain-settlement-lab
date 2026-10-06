#!/usr/bin/env python3
"""Supervise existing demo runners and summarize this invocation's public evidence."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = (
    ("filled-recovery", "order-forwarding", "Filled", "Settled", 1),
    ("cancelled-recovery", "cancellation-forwarding", "Cancelled", "Refunded", 2),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def uint(value, label):
    require((type(value) is int and value >= 0) or
            (isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value)),
            f"{label}: expected an exact unsigned integer")
    return int(value)


def hash32(value, label):
    require(isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", value),
            f"{label}: expected a 32-byte hex value")
    return value


def signature(value):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    require(isinstance(value, str) and 64 <= len(value) <= 88 and
            all(char in alphabet for char in value), "Invalid Solana signature")
    number = 0
    for char in value:
        number = number * 58 + alphabet.index(char)
    size = (number.bit_length() + 7) // 8 + len(value) - len(value.lstrip("1"))
    require(size == 64, "Solana signature must encode 64 bytes")
    return value


def load_public(path):
    require(path.is_file() and not path.is_symlink(), f"Missing public evidence: {path}")
    # Python integers preserve JSON integer quantities without float conversion.
    def invalid_constant(value):
        raise ValueError(f"Invalid JSON constant: {value}")
    value = json.loads(path.read_text(), parse_constant=invalid_constant)
    require(isinstance(value, dict), f"Expected an evidence object: {path}")
    return value


def successful_public(value, label):
    require("failure" not in value, f"{label}: failure recorded")
    checks = value.get("checks")
    require(isinstance(checks, list) and checks and
            all(isinstance(check, str) and check for check in checks),
            f"{label}: missing successful checks")


def runtime_from_log(log, preexisting):
    matches = re.findall(r"^Runtime: (\.runtime/dual-chain-setup-[A-Za-z0-9_-]+)$",
                         log.read_text(), re.MULTILINE)
    require(len(matches) == 1, f"Expected exactly one runtime announcement in {log}")
    relative = matches[0]
    path = ROOT / relative
    require(path.parent == ROOT / ".runtime" and path.is_dir() and
            not path.is_symlink() and path.resolve() == path and
            path.name not in preexisting, "Runner did not announce a fresh local runtime")
    return path


def economics(snapshot):
    values = snapshot["state"]["economics"]
    result = {name: uint(values[name], name) for name in
              ("userCash", "escrow", "executorCash", "userYes")}
    require(isinstance(values["counters"], list) and len(values["counters"]) == 4,
            "Expected four Accounting counters")
    result["counters"] = [uint(value, "Accounting counter") for value in values["counters"]]
    return result


def summarize(runtime, log, scenario, runner_exit_code):
    name, forwarding_stage, outcome, lifecycle, terminal = scenario
    require(type(runner_exit_code) is int and runner_exit_code == 0, "Runner did not exit successfully")
    runner_path = runtime / "runner-evidence.json"
    evidence_path = runtime / f"{name}-live-evidence.json"
    runner = load_public(runner_path)
    expected_stages = {"setup", forwarding_stage, name}
    require(runner["runtimeDirectory"] == str(runtime.relative_to(ROOT)) and
            runner["scenario"] == name and runner["cleanupSelfTest"] is False,
            "Runner identity/scenario mismatch")
    require(runner["failures"] == [] and runner["ownedProcessesStopped"] is True and
            runner["portsReleased"] is True, "Runner failure or unsuccessful cleanup")
    require(runner["hostPortsFreeBeforeFixture"] is True and
            runner["freshAnvil"]["blockNumber"] == "0", "Fixture was not fresh")
    stages = runner["stageExitResults"]
    require(set(stages) == expected_stages and
            all(type(code) is int and code == 0 for code in stages.values()) and
            type(runner["testExitCode"]) is int and runner["testExitCode"] == 0,
            "Missing or unsuccessful runner stages")
    text = log.read_text()
    require("Cleanup: groups stopped=True; ports released=True" in text and
            f"Logs and public evidence preserved: {runtime.relative_to(ROOT)}" in text,
            "Runner did not report successful cleanup")
    public = load_public(evidence_path)
    successful_public(public, name)
    require(public["childrenStopped"] is True, "Recovery children did not stop")
    forwarding_path = runtime / f"{forwarding_stage}{'-live' if terminal == 2 else ''}-evidence.json"
    forwarding = load_public(forwarding_path)
    successful_public(forwarding, forwarding_stage)
    original = (forwarding["stages"]["purchase"]["submissionHash"] if terminal == 1 else
                forwarding["stages"]["forwarding"]["submission"]["transactionHash"])
    original = hash32(original, "Original EVM terminal transaction")
    details = public["stages"]
    expectations = details["independentExpectations"]
    order_id = hash32(expectations["orderId"], "Order ID")
    terms_hash = hash32(expectations["termsHash"], "Terms hash")
    receipt_hash = hash32(expectations["receiptHash"], "Receipt hash")
    require(expectations["originalHash"] == original and
            expectations["original"]["transactionHash"] == original and
            expectations["original"]["status"] == "0x1", "Original EVM receipt mismatch")
    receipt = expectations["canonicalReceipt"]
    require(type(receipt["terminal"]) is int and receipt["terminal"] == terminal and
            receipt["termsHash"] == terms_hash, "Unexpected recovered receipt")
    quantity = uint(receipt["filledQuantity"], "Filled quantity")
    require(quantity > 0 if terminal == 1 else quantity == 0, "Invalid terminal quantity")
    attempts = public["attempts"]
    require(isinstance(attempts, list) and len(attempts) == 3, "Missing recovery attempts")
    for attempt in attempts:
        require("failure" not in attempt and type(attempt["exitCode"]) is int and
                attempt["exitCode"] == 0 and attempt["signal"] is None,
                "Recovery worker failed")
        require(attempt["processId"] == attempt["output"]["processId"], "Worker identity mismatch")
    require(len({attempt["processId"] for attempt in attempts}) == 3,
            "Expected three fresh application processes")
    wait, resumed, complete = (attempt["output"] for attempt in attempts)
    require(wait["observation"]["plan"]["kind"] == "Wait", "Missing initial Wait observation")
    for output in (wait, complete):
        require(all(type(output[key]) is int and output[key] == 0 for key in
                    ("submissionCount", "credentialReads", "signingCount")) and
                output["delivery"] is None and output["deliveryReads"] == [],
                "Read-only recovery submitted or signed a transaction")
    require(type(resumed["submissionCount"]) is int and resumed["submissionCount"] == 1,
            "Recovery must deliver exactly once")
    for output in (resumed, complete):
        destination = output["observation"]["destination"]
        observed = destination["observation"]
        require(destination["kind"] == "Observed" and observed["kind"] == "Confirmed" and
                destination["transactionHash"] == original and observed["transactionHash"] == original and
                observed["orderId"] == order_id and observed["termsHash"] == terms_hash and
                observed["receipt"] == receipt and observed["receiptHash"] == receipt_hash,
                "Recovered terminal observation mismatch")
        additional = uint(observed["additionalBlocks"], "Additional EVM blocks")
        require(additional >= 2 and uint(observed["observationHead"]["number"], "EVM head") -
                uint(observed["inclusion"]["number"], "EVM inclusion") == additional,
                "Missing local EVM N+2 confirmation")
        source = output["observation"]["source"]
        require(source["orderId"] == order_id and source["termsHash"] == terms_hash and
                source["cancellationRequested"] is True, "Missing source identity/cancellation history")
    require(resumed["observation"]["plan"]["kind"] == f"Deliver{outcome}" and
            resumed["observation"]["source"]["state"] == "CancelRequested",
            "Unexpected resumed source state or plan")
    delivery = details["delivery"]
    sig = signature(delivery["signature"])
    slot = uint(delivery["finalizedSlot"], "Finalized Solana slot")
    require(slot > 0 and delivery["record"]["slot"] == slot and
            delivery["record"]["meta"]["err"] is None and
            delivery["record"]["transaction"]["signatures"][0] == sig and
            delivery["recoveredOriginalHash"] == original and
            resumed["delivery"]["signature"] == sig and
            resumed["delivery"]["finalizedSlot"] == slot, "Invalid finalized delivery")
    final_source = complete["observation"]["source"]
    require(final_source == resumed["delivery"]["source"] or
            {k: v for k, v in final_source.items() if k != "contextSlot"} ==
            {k: v for k, v in resumed["delivery"]["source"].items() if k != "contextSlot"},
            "Delivery and completion source records disagree")
    require(final_source["state"] == lifecycle and uint(final_source["contextSlot"], "Source context") >= slot and
            final_source["acceptedReceipt"] == {"terminal": terminal, "filledQuantity": receipt["filledQuantity"],
                                                "receiptHash": receipt_hash}, "Invalid final source lifecycle/receipt")
    plan = complete["observation"]["plan"]
    require(plan == {"kind": "Complete", "sourceState": lifecycle, "orderId": order_id,
                     "termsHash": terms_hash, "receiptHash": receipt_hash} and
            details["complete"] == {"processId": complete["processId"], "plan": plan,
                                    "credentialReads": 0, "submissionCount": 0, "signingCount": 0},
            "Recovery did not finish Complete without further submissions")
    final = economics(delivery["source"])
    before = economics(attempts[1]["before"]["source"])
    require(final == economics(attempts[1]["after"]["source"]) ==
            economics(attempts[2]["before"]["source"]) == economics(attempts[2]["after"]["source"]),
            "Final balances or accounting disagree across completion")
    require(attempts[2]["unchanged"] is True and
            attempts[2]["before"]["source"]["state"] == attempts[2]["after"]["source"]["state"],
            "Complete changed source state/activity")
    activity = delivery["source"]["state"]["activity"]
    require(any(item["signature"] == sig and item["slot"] == slot and item["err"] is None and
                item["confirmationStatus"] == "finalized" for item in activity),
            "Delivery is absent from finalized source activity")
    deposited, refunded, reimbursed, issued = final["counters"]
    cash = uint(expectations["terms"]["cashAmount"], "Cash amount")
    require(deposited == cash and final["escrow"] == uint(final_source["escrowBalance"], "Final escrow") == 0 and
            (refunded, reimbursed, issued) == ((0, cash, quantity) if terminal == 1 else (cash, 0, 0)),
            "Terminal accounting does not match recovered terms")
    require(before["escrow"] == cash and final["userCash"] == before["userCash"] + refunded and
            final["executorCash"] == before["executorCash"] + reimbursed and
            final["userYes"] == before["userYes"] + issued, "Token effects disagree with accounting")
    if terminal == 1:
        cancellation = details["cancellation"]
        signature(cancellation["signature"])
        require(0 < uint(cancellation["finalizedSlot"], "Cancellation slot") < slot and
                any(item["signature"] == cancellation["signature"] and
                    item["confirmationStatus"] == "finalized" and item["err"] is None for item in activity),
                "Missing finalized user cancellation before settlement")
    logs = [runtime / "tests.log", runtime / f"{forwarding_stage}.log", runtime / f"{name}.log"]
    require(all(path.is_file() for path in logs), "Missing scenario stage logs")
    return {
        "scenario": name, "status": "passed", "freshDeployment": str(runtime.relative_to(ROOT)),
        "orderId": order_id, "originalEvmTerminalTransactionHash": original,
        "recoveredTerminalOutcome": {1: "Filled", 2: "Cancelled"}[receipt["terminal"]],
        "solanaDeliverySignature": sig,
        "finalizedSolanaDeliverySlot": str(slot), "finalSourceState": final_source["state"],
        "cancellationRequested": final_source["cancellationRequested"],
        "sourceBalancesBaseUnits": {key: str(final[key]) for key in
                                   ("userCash", "escrow", "executorCash", "userYes")},
        "accountingBaseUnits": dict(zip(("deposited", "refunded", "reimbursed", "issued"),
                                        map(str, final["counters"]))),
        "recoveryCompletion": {"kind": plan["kind"], "furtherSubmissions": complete["submissionCount"]},
        "runnerExitCode": runner_exit_code, "stageExitResults": stages,
        "cleanup": {key: runner[key] for key in ("ownedProcessesStopped", "portsReleased")},
        "publicEvidence": [str(path.relative_to(ROOT)) for path in (evidence_path, runner_path, forwarding_path)],
        "logs": [str(log.relative_to(ROOT)), *[str(path.relative_to(ROOT)) for path in logs]],
    }


class Supervisor:
    def __init__(self):
        self.interruption = None
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, self.interrupted)

    def interrupted(self, signum, _frame):
        if self.interruption is None:
            self.interruption = signum

    def run(self, script, log, timeout, runner=False):
        require(self.interruption is None, f"Interrupted by signal {self.interruption}")
        with log.open("wb") as handle:
            process = subprocess.Popen(["bash", str(ROOT / "scripts" / script)], cwd=ROOT,
                                       stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + timeout
            stopped = None
            while process.poll() is None:
                if stopped is None and (self.interruption is not None or time.monotonic() >= deadline):
                    stopped = (f"Interrupted by signal {self.interruption}" if self.interruption is not None
                               else f"{script} exceeded {timeout}s deadline")
                    print(f"{stopped}; waiting for {'runner cleanup' if runner else 'build/tool processes'}.", flush=True)
                    try:
                        # The runner alone owns nodes and their detached groups.
                        # Signal its PID, then wait through its existing finally cleanup.
                        if runner:
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
                time.sleep(0.1)
            code = process.wait()
        return code, stopped or (f"Interrupted by signal {self.interruption}" if self.interruption else None)


def print_scenario(result):
    print(f"\n{result['recoveredTerminalOutcome']} recovery — separate fresh deployment: {result['freshDeployment']}")
    print(f"  Order ID: {result['orderId']}")
    print(f"  Original EVM terminal transaction: {result['originalEvmTerminalTransactionHash']}")
    print(f"  Recovered terminal: {result['recoveredTerminalOutcome']}; source lifecycle: {result['finalSourceState']}")
    print(f"  Finalized Solana delivery: {result['solanaDeliverySignature']} (slot {result['finalizedSolanaDeliverySlot']})")
    labels = {"userCash": "user cash", "escrow": "escrow cash", "executorCash": "executor cash", "userYes": "user YES"}
    print("  Source SPL balances (base units): " + "; ".join(f"{labels[key]}={value}" for key, value in result["sourceBalancesBaseUnits"].items()))
    print("  Accounting (base units): " + "; ".join(f"{key}={value}" for key, value in result["accountingBaseUnits"].items()))
    completion = result["recoveryCompletion"]
    print(f"  Recovery: {completion['kind']}; further submissions={completion['furtherSubmissions']}; cleanup verified")
    if result["recoveredTerminalOutcome"] == "Filled":
        print("  User requested cancellation after execution. Filled wins: source settles and cancellation history is preserved.")
    for key, label in (("publicEvidence", "Public evidence"), ("logs", "Logs")):
        print(f"  {label}: " + ", ".join(result[key]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()  # Also reject direct Python arguments before any work.
    supervisor = Supervisor()
    runtime_root = ROOT / ".runtime"
    runtime_root.mkdir(exist_ok=True)
    demo = Path(tempfile.mkdtemp(prefix="demo-", dir=runtime_root))
    summary_path = demo / "demo-summary.json"
    summary = {"status": "running", "tokenDecimals": 6, "amountUnit": "base units",
               "scenarios": [], "logs": {"prerequisites": str((demo / "prerequisites.log").relative_to(ROOT)),
                                         "build": str((demo / "build.log").relative_to(ROOT))}}

    def persist():
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    persist()
    print(f"Demo logs and public summary: {demo.relative_to(ROOT)}", flush=True)
    try:
        require(os.environ.get("LAB_ROOT") == str(ROOT), "Use bash scripts/run-demo.sh to select scripts/env.sh")
        tools = ("bash", "python3", "rustup", "rustc", "cargo", "avm", "anchor", "cargo-build-sbf",
                 "solana", "solana-keygen", "solana-test-validator", "forge", "cast", "anvil",
                 "node", "npm", "unshare", "ip", "sha256sum")
        missing = [name for name in tools if shutil.which(name) is None]
        require(not missing, "Missing prerequisites: " + ", ".join(missing) + ". See docs/development.md; no automatic installation.")
        require((ROOT / ".local/solc-0.8.30").is_file() and
                (ROOT / "harness/node_modules/typescript/bin/tsc").is_file(),
                "Missing pinned Solidity compiler or harness dependencies; see docs/development.md")
        for script, log, timeout in (("check-tools.sh", demo / "prerequisites.log", 120),
                                     ("check-builds.sh", demo / "build.log", 1800)):
            print(f"Running {script}; detailed output: {log.relative_to(ROOT)}", flush=True)
            code, stopped = supervisor.run(script, log, timeout)
            require(code == 0 and stopped is None, stopped or f"{script} failed (exit {code}); see {log.relative_to(ROOT)}")
        summary["buildExitCode"] = code
        persist()
        for scenario in SCENARIOS:
            name = scenario[0]
            log = demo / f"{name}.log"
            summary["logs"][name] = str(log.relative_to(ROOT))
            persist()
            preexisting = {path.name for path in runtime_root.iterdir()}
            print(f"Running {name} on a separate fresh deployment; log: {log.relative_to(ROOT)}", flush=True)
            code, stopped = supervisor.run(f"check-{name}.sh", log, 2000, runner=True)
            if code != 0 or stopped:
                # Only the active runner's announcement can identify its evidence.
                try:
                    failed_runtime = runtime_from_log(log, preexisting)
                    summary["failedScenarioRuntime"] = str(failed_runtime.relative_to(ROOT))
                    print(f"Active runner logs/evidence: {failed_runtime.relative_to(ROOT)}", flush=True)
                except ValueError:
                    pass
                diagnostics = [line for line in log.read_text().splitlines() if
                               line.startswith(("FAIL:", "RuntimeError:", "ValueError:", "Cleanup:"))]
                require(False, stopped or f"{name} failed (exit {code}): " +
                        ("; ".join(diagnostics[-3:]) or f"see {log.relative_to(ROOT)}"))
            result = summarize(runtime_from_log(log, preexisting), log, scenario, code)
            require(all(result["freshDeployment"] != earlier["freshDeployment"] for earlier in summary["scenarios"]),
                    "Scenarios must use separate fresh deployments")
            summary["scenarios"].append(result)
            persist()
        require(supervisor.interruption is None, f"Interrupted by signal {supervisor.interruption}")
        summary["status"] = "passed"
        persist()
        print("\nTokens use six decimals; all amounts below are exact integer base units.")
        for result in summary["scenarios"]:
            print_scenario(result)
        print(f"\nPASS: both separate fresh recovery scenarios and cleanup verified. Summary: {summary_path.relative_to(ROOT)}")
        return 0
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, OSError) as error:
        summary["status"] = "failed"
        summary["failure"] = str(error)
        persist()
        print(f"FAIL: {error}\nLogs preserved: {demo.relative_to(ROOT)}\nPublic summary: {summary_path.relative_to(ROOT)}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
