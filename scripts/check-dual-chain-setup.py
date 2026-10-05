#!/usr/bin/env python3
"""Own two fresh local chains in one loopback-only network namespace."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


PROGRAM = "7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK"
SIMD_0500 = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"
PORTS = [18545, 18899, 18900, 18901, *range(19010, 19041)]


def check_ports():
    for port in PORTS:
        for protocol in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            with socket.socket(socket.AF_INET, protocol) as probe:
                if protocol == socket.SOCK_STREAM:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", port))
                    if protocol == socket.SOCK_STREAM:
                        probe.listen(1)
                except OSError as error:
                    raise RuntimeError(f"Required port {port} is occupied ({protocol.name})") from error


def group_exists(process):
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_owned(process):
    # Every group is created with start_new_session, exclusively by this runner.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        process.poll()
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--isolated-network", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--cleanup-self-test", action="store_true",
                        help="Run a disposable failing test after both nodes are ready, then verify cleanup")
    parser.add_argument("--scenario", choices=("setup", "order-forwarding", "terminal-observation"), default="setup")
    args = parser.parse_args()
    root = Path(os.environ["LAB_ROOT"]).resolve()
    binary = root / "solana/target/deploy/settlement_lab.so"
    idl = root / "solana/target/idl/settlement_lab.json"
    if not binary.is_file() or binary.stat().st_size == 0:
        raise ValueError("Build the actual SBF program first")
    if json.loads(idl.read_text())["address"] != PROGRAM:
        raise ValueError("Generated IDL has the wrong program identity")
    for name in ("MockERC20", "MockVenue", "Settlement"):
        if not (root / f"evm/out/{name}.sol/{name}.json").is_file():
            raise ValueError(f"Build the actual {name} artifact first")
    # Reject occupied host ports before namespace entry or any fixture creation.
    check_ports()
    if not args.isolated_network:
        os.environ["DUAL_CHAIN_PARENT_NET"] = os.readlink("/proc/self/ns/net")
        command = ["unshare", "--user", "--map-root-user", "--net", "--", "python3",
                   str(Path(__file__).resolve()), "--isolated-network", "--scenario", args.scenario]
        if args.cleanup_self_test:
            command.append("--cleanup-self-test")
        os.execvp(command[0], command)
    parent = os.environ.get("DUAL_CHAIN_PARENT_NET")
    current = os.readlink("/proc/self/ns/net")
    if not parent or current == parent:
        raise ValueError("A fresh isolated network namespace is required")
    if [name for _, name in socket.if_nameindex()] != ["lo"]:
        raise ValueError("The isolated namespace must contain only loopback")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=10)
    os.umask(0o077)
    (root / ".runtime").mkdir(exist_ok=True)
    runtime = Path(tempfile.mkdtemp(prefix="dual-chain-setup-", dir=root / ".runtime"))
    evidence = {
        "runtimeDirectory": str(runtime.relative_to(root)), "programId": PROGRAM,
        "sbfSha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "isolatedNetwork": {"parent": parent, "current": current, "interfaces": ["lo"]},
        "hostPortsFreeBeforeFixture": True, "reservedPorts": PORTS,
        "portReleaseScope": "Runner-owned namespace, all reserved TCP/UDP ports",
        "localGenesisLimitation": {"deactivatedFeature": SIMD_0500,
                                   "reason": "Agave 4.1.2 SIMD-0500 prevents SetAuthority(None) for this SBPF v0 fixture"},
        "scenario": args.scenario, "stageExitResults": {},
        "scope": ("Disposable failing test after node readiness; cleanup verification only"
                  if args.cleanup_self_test else
                  "Simultaneous live local configuration agreement only; no orders, receipt transport, cross-chain proofs or production finality"
                  if args.scenario == "setup" else
                  "Real finalized source creation and destination purchase; source escrow remains Pending without receipt delivery. No completed cross-chain settlement, reusable terminal-finality observer or production finality"
                  if args.scenario == "order-forwarding" else
                  "Live destination observation of EVM-only fixture orders; unchanged source state. No source refund eligibility, receipt delivery, completed cross-chain flow, production finality or restart recovery"),
        "cleanupSelfTest": args.cleanup_self_test, "ownedProcessGroups": [],
    }
    processes, handles, failures = [], [], []
    stage_processes = {}
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def rpc(port, method, params=None):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode(),
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
        process = subprocess.Popen(command, cwd=root, env=env, stdout=handle,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        evidence["ownedProcessGroups"].append({"name": name, "pid": process.pid, "processGroup": process.pid})
        return process

    def nodes_alive():
        for name, process in (("Anvil", anvil), ("validator", validator)):
            if process.poll() is not None:
                raise RuntimeError(f"{name} exited unexpectedly: {process.returncode}")

    def interrupted(signum, _frame):
        raise RuntimeError(f"Interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    print(f"Runtime: {runtime.relative_to(root)}", flush=True)
    try:
        credentials = runtime / "credentials"
        credentials.mkdir(mode=0o700)
        public_keys = {}
        for name in ("initializer", "operator", "executor", "cash-mint", "yes-mint"):
            path = credentials / f"{name}.json"
            subprocess.run(["solana-keygen", "new", "--silent", "--no-bip39-passphrase", "--outfile", str(path)],
                           stdout=subprocess.DEVNULL, check=True, timeout=30)
            path.chmod(0o600)
            public_keys[name] = subprocess.check_output(["solana-keygen", "pubkey", str(path)], text=True, timeout=10).strip()
        evidence["publicKeys"] = public_keys
        config = runtime / "solana.yml"
        config.write_text("json_rpc_url: http://127.0.0.1:18899\nwebsocket_url: ws://127.0.0.1:18900\n"
                          f"keypair_path: {credentials / 'initializer.json'}\ncommitment: finalized\n")
        ledger = runtime / "ledger"
        if ledger.exists():
            raise RuntimeError("Refusing an existing ledger")
        check_ports()
        evidence["anvilVersion"] = subprocess.check_output(["anvil", "--version"], text=True, timeout=10).strip()
        anvil = start(["anvil", "--host", "127.0.0.1", "--port", "18545", "--chain-id", "31337", "--silent"], "anvil")
        validator = start([
            "solana-test-validator", "--quiet", "--config", str(config), "--ledger", str(ledger),
            "--bind-address", "127.0.0.1", "--rpc-port", "18899", "--faucet-port", "18901",
            "--gossip-port", "19010", "--dynamic-port-range", "19011-19040", "--ticks-per-slot", "8",
            "--mint", public_keys["initializer"], "--limit-ledger-size", "10000",
            "--deactivate-feature", SIMD_0500, "--upgradeable-program", PROGRAM, str(binary), public_keys["initializer"],
        ], "validator")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            nodes_alive()
            try:
                if (rpc(18545, "eth_chainId") == "0x7a69" and rpc(18545, "eth_blockNumber") == "0x0"
                        and rpc(18899, "getHealth") == "ok"
                        and rpc(18899, "getSlot", [{"commitment": "finalized"}]) > 0):
                    break
            except (OSError, ValueError, urllib.error.URLError, RuntimeError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("Dual RPC readiness deadline exceeded")
        evidence["freshAnvil"] = {"chainId": str(int(rpc(18545, "eth_chainId"), 16)),
                                  "blockNumber": str(int(rpc(18545, "eth_blockNumber"), 16)),
                                  "blockZeroHash": rpc(18545, "eth_getBlockByNumber", ["0x0", False])["hash"]}
        evidence["validatorVersion"] = rpc(18899, "getVersion")
        if evidence["validatorVersion"]["solana-core"] != "4.1.2":
            raise RuntimeError("Expected pinned Agave 4.1.2")
        evidence["genesisHash"] = rpc(18899, "getGenesisHash")
        evidence["readyFinalizedSlot"] = rpc(18899, "getSlot", [{"commitment": "finalized"}])
        print("PASS: both fresh RPCs ready in one loopback-only namespace", flush=True)
        env = os.environ.copy()
        env["DUAL_CHAIN_SETUP_RUNTIME"] = str(runtime)
        if args.cleanup_self_test:
            # A runner-owned disposable test, never a fault in protocol/verifier code.
            fixture = runtime / "disposable-failure.test.mjs"
            fixture.write_text('import {test} from "node:test"; import assert from "node:assert/strict";\n'
                               'test("controlled cleanup failure", () => assert.fail("Disposable runner-owned failure"));\n')
            command = ["node", "--test", str(fixture)]
        else:
            command = ["npm", "--prefix", "harness", "run", "test:dual-chain-setup"]
        tests = start(command, "tests", env)
        stage_processes["cleanup-self-test" if args.cleanup_self_test else "setup"] = tests
        deadline = time.monotonic() + 600
        while tests.poll() is None:
            nodes_alive()
            if time.monotonic() >= deadline:
                raise RuntimeError("Dual-chain test deadline exceeded (600 seconds)")
            time.sleep(0.2)
        nodes_alive()
        print((runtime / "tests.log").read_text(), flush=True)
        evidence["testExitCode"] = tests.returncode
        evidence["stageExitResults"]["cleanup-self-test" if args.cleanup_self_test else "setup"] = tests.returncode
        if tests.returncode != 0:
            raise RuntimeError(f"Dual-chain tests failed: {tests.returncode}")
        for name in ("evm-deployment-manifest.json", "solana-deployment-manifest.json", "agreement-evidence.json"):
            if not (runtime / name).is_file():
                raise RuntimeError(f"Missing public output: {name}")
        if args.scenario in ("order-forwarding", "terminal-observation"):
            stage = args.scenario
            suite = "test:order-forwarding" if stage == "order-forwarding" else "test:terminal-observation-live"
            output = "order-forwarding-evidence.json" if stage == "order-forwarding" else "terminal-observation-live-evidence.json"
            tests = start(["npm", "--prefix", "harness", "run", suite], stage, env)
            stage_processes[stage] = tests
            deadline = time.monotonic() + 600
            while tests.poll() is None:
                nodes_alive()
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"{stage} test deadline exceeded (600 seconds)")
                time.sleep(0.2)
            nodes_alive()
            print((runtime / f"{stage}.log").read_text(), flush=True)
            evidence["stageExitResults"][stage] = tests.returncode
            if tests.returncode != 0:
                raise RuntimeError(f"{stage} tests failed: {tests.returncode}")
            if not (runtime / output).is_file():
                raise RuntimeError(f"Missing public output: {output}")
    except Exception as error:
        failures.append(str(error))
    finally:
        # Ignore further interruptions only while attempting every owned cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup_failures = []
        for process in reversed(processes):
            try:
                stop_owned(process)
            except Exception as error:
                cleanup_failures.append(str(error))
        for handle in handles:
            handle.close()
        evidence["stageExitResults"].update({name: process.returncode for name, process in stage_processes.items()})
        evidence["ownedProcessesStopped"] = not cleanup_failures
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    check_ports()
                    break
                except RuntimeError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Owned dual-chain ports were not released")
                    time.sleep(0.2)
            evidence["portsReleased"] = True
        except Exception as error:
            cleanup_failures.append(str(error))
            evidence["portsReleased"] = False
        failures.extend(cleanup_failures)
        evidence["failures"] = failures
        (runtime / "runner-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(f"Cleanup: groups stopped={evidence['ownedProcessesStopped']}; ports released={evidence['portsReleased']}", flush=True)
        print(f"Logs and public evidence preserved: {runtime.relative_to(root)}", flush=True)
    if failures:
        raise SystemExit("FAIL: " + "; ".join(failures))


if __name__ == "__main__":
    main()
