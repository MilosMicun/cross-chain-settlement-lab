#!/usr/bin/env python3
"""Initialize one isolated source fixture from a previously verified EVM run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


PROGRAM = "7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK"
SIMD_0500 = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"
PORTS = [18899, 18900, 18901, *range(19010, 19041)]


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


def validate_manifest(path, root):
    # Accept public output of a successful existing runner, including its offline
    # readbacks. These local files are provenance aids, never cross-chain proofs.
    path = path.resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError("The EVM manifest must be inside this repository")
    raw = path.read_bytes()
    manifest = json.loads(raw)
    runner_raw = path.with_name("runner-evidence.json").read_bytes()
    readbacks_raw = path.with_name("deployment-evidence.json").read_bytes()
    runner = json.loads(runner_raw)
    readbacks = json.loads(readbacks_raw)
    if (runner.get("testExitCode") != 0 or runner.get("failures") != []
            or runner.get("ownedProcessesStopped") is not True
            or runner.get("portReleased") is not True or readbacks.get("failure")):
        raise ValueError("Expected evidence of a successfully completed EVM deployment runner")
    if (type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1
            or manifest.get("chainId") != "31337"
            or type(manifest.get("outcome")) is not int or manifest["outcome"] != 0
            or type(manifest.get("tokenDecimals")) is not int or manifest["tokenDecimals"] != 6):
        raise ValueError("Expected manifest v1, local chain 31337, YES and six decimals")

    def hex_field(value, width):
        if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{" + str(width * 2) + r"}", value):
            raise ValueError(f"Expected a {width}-byte hex field")
        if int(value[2:], 16) == 0:
            raise ValueError("Manifest identities must be nonzero")
        return value.lower()

    for field in ("sourceDomain", "destinationDomain", "solanaProgram", "market"):
        hex_field(manifest[field], 32)
    if manifest["sourceDomain"].lower() == manifest["destinationDomain"].lower():
        raise ValueError("Deployment domains must be distinct")
    for container, fields in (("roles", ("deployer", "operator", "executor")),
                              ("contracts", ("usd", "yes", "venue", "settlement"))):
        addresses = [hex_field(manifest[container][field], 20) for field in fields]
        if len(set(addresses)) != len(addresses):
            raise ValueError(f"Distinct {container} addresses are required")
    if manifest["funding"] != {"executorUsd": "100000000", "venueYes": "200000000", "executorAllowance": "100000000"}:
        raise ValueError("Expected existing EVM fixture funding")
    steps = ("usdDeployment", "yesDeployment", "venueDeployment", "settlementDeployment",
             "executorFunding", "venueFunding", "executorApproval")
    receipts = readbacks["observed"]["receipts"]
    if set(manifest["transactions"]) != set(steps) or len(receipts) != len(steps):
        raise ValueError("Expected all seven independently verified setup receipts")
    for block, step in enumerate(steps, 1):
        receipt = manifest["transactions"][step]
        hex_field(receipt["transactionHash"], 32)
        hex_field(receipt["blockHash"], 32)
        if type(receipt["blockNumber"]) is not int or receipt["blockNumber"] != block:
            raise ValueError("Expected fresh EVM setup receipt block sequence")
        observed = next(item for item in receipts if item["step"] == step)
        if observed["status"] != 1 or any(observed[field] != receipt[field] for field in receipt):
            raise ValueError("EVM manifest disagrees with independently observed receipt evidence")
        if block <= 4:
            contract = ("usd", "yes", "venue", "settlement")[block - 1]
            if observed["contractAddress"] != manifest["contracts"][contract]:
                raise ValueError("Manifest contract address disagrees with the actual deployment receipt")
    selected = readbacks["observed"]["selectedConfiguration"]
    for field in ("sourceDomain", "destinationDomain", "solanaProgram", "market", "roles"):
        if manifest[field] != selected[field]:
            raise ValueError("Manifest disagrees with selected EVM configuration")
    # Reuse the existing representation validator for checksum addresses, program
    # bytes and full uint256 conversion before starting or creating a fixture.
    subprocess.run([
        "node", "--input-type=module", "-e",
        'import {readFileSync} from "node:fs"; import {PublicKey} from "@solana/web3.js"; '
        'import {buildInitializeArgs} from "./src/solana-configuration.ts"; '
        'const manifest=JSON.parse(readFileSync(process.argv[1],"utf8")); '
        'buildInitializeArgs(manifest,new PublicKey(process.argv[2]),'
        'new PublicKey(process.argv[2]),new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));',
        str(path), PROGRAM,
    ], cwd=root / "harness", check=True, timeout=20)
    if path.read_bytes() != raw:
        raise ValueError("Input manifest changed during validation")
    return path, raw, runner_raw, readbacks_raw


def group_exists(process):
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_owned(process):
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
    parser.add_argument("--evm-manifest", type=Path, required=True)
    parser.add_argument("--isolated-network", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = Path(os.environ["LAB_ROOT"]).resolve()
    path, raw, evm_runner_raw, evm_readbacks_raw = validate_manifest(args.evm_manifest, root)
    binary = root / "solana/target/deploy/settlement_lab.so"
    idl_path = root / "solana/target/idl/settlement_lab.json"
    idl_types = root / "solana/target/types/settlement_lab.ts"
    if not binary.is_file() or binary.stat().st_size == 0 or not idl_types.is_file():
        raise ValueError("Build the actual SBF program and generated IDL first")
    if json.loads(idl_path.read_text())["address"] != PROGRAM:
        raise ValueError("Generated IDL has the wrong program identity")
    check_ports()
    if not args.isolated_network:
        os.environ["SOLANA_DEPLOYMENT_PARENT_NET"] = os.readlink("/proc/self/ns/net")
        os.execvp("unshare", [
            "unshare", "--user", "--map-root-user", "--net", "--", "python3",
            str(Path(__file__).resolve()), "--isolated-network", "--evm-manifest", str(path),
        ])
    parent = os.environ.get("SOLANA_DEPLOYMENT_PARENT_NET")
    if not parent or os.readlink("/proc/self/ns/net") == parent:
        raise ValueError("A fresh isolated network namespace is required")
    if [name for _, name in socket.if_nameindex()] != ["lo"]:
        raise ValueError("The isolated namespace must contain only loopback")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=10)
    os.umask(0o077)
    (root / ".runtime").mkdir(exist_ok=True)
    runtime = Path(tempfile.mkdtemp(prefix="solana-deployment-", dir=root / ".runtime"))
    evidence = {
        "runtimeDirectory": str(runtime.relative_to(root)), "inputManifest": str(path.relative_to(root)),
        "inputManifestSha256": hashlib.sha256(raw).hexdigest(), "programId": PROGRAM,
        "sbfSha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "isolatedNetwork": {"parent": parent, "current": os.readlink("/proc/self/ns/net"), "interfaces": ["lo"]},
        "hostPortsFreeBeforeFixture": True,
        "reservedPorts": PORTS, "portReleaseScope": "Runner-owned isolated network namespace, TCP and UDP",
        "localGenesisLimitation": {"deactivatedFeature": SIMD_0500,
                                   "reason": "Agave 4.1.2 SIMD-0500 prevents SetAuthority(None) for this SBPF v0 fixture"},
        "scope": "Previously verified EVM manifest only; no simultaneous chains or live agreement proof",
        "ownedProcessGroups": [],
    }
    processes, handles, failures = [], [], []
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def rpc(method, params=None):
        request = urllib.request.Request(
            "http://127.0.0.1:18899",
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
        evidence["ownedProcessGroups"].append({"name": name, "pid": process.pid})
        return process

    def interrupted(signum, _frame):
        raise RuntimeError(f"Interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    print(f"Runtime: {runtime.relative_to(root)}", flush=True)
    try:
        (runtime / "evm-deployment-manifest.json").write_bytes(raw)
        (runtime / "evm-runner-evidence.json").write_bytes(evm_runner_raw)
        (runtime / "evm-deployment-evidence.json").write_bytes(evm_readbacks_raw)
        credentials = runtime / "credentials"
        credentials.mkdir(mode=0o700)
        public_keys = {}
        for name in ("initializer", "operator", "executor", "cash-mint", "yes-mint"):
            key_path = credentials / f"{name}.json"
            subprocess.run(["solana-keygen", "new", "--silent", "--no-bip39-passphrase", "--outfile", str(key_path)],
                           stdout=subprocess.DEVNULL, check=True, timeout=30)
            key_path.chmod(0o600)
            public_keys[name] = subprocess.check_output(["solana-keygen", "pubkey", str(key_path)], text=True, timeout=10).strip()
        evidence["publicKeys"] = public_keys
        authority_path = credentials / "initializer.json"
        config = runtime / "solana.yml"
        config.write_text("json_rpc_url: http://127.0.0.1:18899\nwebsocket_url: ws://127.0.0.1:18900\n"
                          f"keypair_path: {authority_path}\ncommitment: finalized\n")
        ledger = runtime / "ledger"
        if ledger.exists():
            raise RuntimeError("Refusing an existing ledger")
        check_ports()
        validator = start([
            "solana-test-validator", "--quiet", "--config", str(config), "--ledger", str(ledger),
            "--bind-address", "127.0.0.1", "--rpc-port", "18899", "--faucet-port", "18901",
            "--gossip-port", "19010", "--dynamic-port-range", "19011-19040", "--ticks-per-slot", "8",
            "--mint", public_keys["initializer"], "--limit-ledger-size", "10000",
            "--deactivate-feature", SIMD_0500, "--upgradeable-program", PROGRAM, str(binary), public_keys["initializer"],
        ], "validator")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if validator.poll() is not None:
                raise RuntimeError(f"Validator exited before readiness: {validator.returncode}")
            try:
                # Health may report ok while the finalized bank is still genesis.
                # Pinned genesis-loaded SPL programs become executable after slot 0.
                if rpc("getHealth") == "ok" and rpc("getSlot", [{"commitment": "finalized"}]) > 0:
                    break
            except (OSError, ValueError, urllib.error.URLError, RuntimeError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("Validator RPC readiness deadline exceeded")
        evidence["validatorVersion"] = rpc("getVersion")
        if evidence["validatorVersion"]["solana-core"] != "4.1.2":
            raise RuntimeError("Expected pinned Agave 4.1.2")
        evidence["genesisHash"] = rpc("getGenesisHash")
        evidence["readyFinalizedSlot"] = rpc("getSlot", [{"commitment": "finalized"}])
        print("PASS: fresh ledger, pinned SBF program and loopback-only namespace", flush=True)
        env = os.environ.copy()
        env["SOLANA_DEPLOYMENT_RUNTIME"] = str(runtime)
        tests = start(["npm", "--prefix", "harness", "run", "test:solana-deployment"], "tests", env)
        deadline = time.monotonic() + 600
        while tests.poll() is None:
            if validator.poll() is not None:
                raise RuntimeError(f"Validator exited during tests: {validator.returncode}")
            if time.monotonic() >= deadline:
                raise RuntimeError("Source deployment test deadline exceeded (600 seconds)")
            time.sleep(0.2)
        print((runtime / "tests.log").read_text(), flush=True)
        evidence["testExitCode"] = tests.returncode
        if tests.returncode != 0:
            raise RuntimeError(f"Source deployment tests failed: {tests.returncode}")
        for name in ("solana-deployment-manifest.json", "solana-deployment-evidence.json"):
            if not (runtime / name).is_file():
                raise RuntimeError(f"Missing public output: {name}")
        if path.read_bytes() != raw:
            raise RuntimeError("Original EVM manifest changed")
        evidence["originalManifestUnchanged"] = True
        if validator.poll() is not None:
            raise RuntimeError("Validator exited unexpectedly after tests")
    except Exception as error:
        failures.append(str(error))
    finally:
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
            deadline = time.monotonic() + 10
            while True:
                try:
                    check_ports()
                    break
                except RuntimeError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Owned validator ports were not released after cleanup")
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
