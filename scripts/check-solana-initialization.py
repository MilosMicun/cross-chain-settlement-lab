#!/usr/bin/env python3
"""Run isolated suites, including Cancelled and two-ledger Filled/Cancelled rollback."""

import base64
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

arguments = sys.argv[1:]
if arguments not in ([], ["--orders"], ["--cancellation"], ["--filled"], ["--filled-rollback"], ["--cancelled-rollback"], ["--cancelled"], ["--isolated-network"],
                     ["--isolated-network", "--orders"], ["--isolated-network", "--cancellation"], ["--isolated-network", "--filled"],
                     ["--isolated-network", "--filled-rollback"], ["--isolated-network", "--cancelled-rollback"], ["--isolated-network", "--cancelled"]):
    raise SystemExit("Unexpected runner arguments")
cancelled_mode = "--cancelled" in arguments
filled_mode = "--filled" in arguments
cancelled_rollback_mode = "--cancelled-rollback" in arguments
rollback_mode = "--filled-rollback" in arguments or cancelled_rollback_mode
rollback_name = "cancelled-rollback" if cancelled_rollback_mode else "filled-rollback"
rollback_prefix = "cancelled-rollback" if cancelled_rollback_mode else "rollback"
rollback_phase = "CANCELLED_ROLLBACK_PHASE" if cancelled_rollback_mode else "FILLED_ROLLBACK_PHASE"
cancellation_mode = "--cancellation" in arguments or filled_mode
orders_mode = "--orders" in arguments or cancellation_mode

root = Path(os.environ["LAB_ROOT"])
program_id = "7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK"
# Agave 4.1.2 SIMD-0500 otherwise rejects SetAuthority(None) for the pinned
# SBPF v0 artifact. Disable only this local genesis feature, not global settings.
disable_legacy_deployment_feature = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"
binary = root / "solana/target/deploy/settlement_lab.so"
idl_path = root / "solana/target/idl/settlement_lab.json"
idl_types = root / "solana/target/types/settlement_lab.ts"
if not binary.is_file() or binary.stat().st_size == 0 or not idl_path.is_file() or not idl_types.is_file():
    raise SystemExit("Build the SBF program and IDL before running this check")
idl = json.loads(idl_path.read_text())
if idl["address"] != program_id or sorted(ix["name"] for ix in idl["instructions"]) != ["accept_cancelled", "accept_filled", "create_order", "initialize", "request_cancel"]:
    raise SystemExit("Expected the unchanged program ID and exactly initialize, create_order, request_cancel, accept_filled, and accept_cancelled in the IDL")

ports = [18899, 18900, 18901, *range(19010, 19041)]
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
processes = []
handles = []


def rpc(method):
    request = urllib.request.Request(
        "http://127.0.0.1:18899",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": []}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with http.open(request, timeout=2) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(f"{method}: {result['error']}")
    return result["result"]


def check_ports():
    for port in ports:
        for protocol in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            with socket.socket(socket.AF_INET, protocol) as probe:
                if protocol == socket.SOCK_STREAM:
                    # Permit rebinding after our closed HTTP sockets enter TIME_WAIT,
                    # while still rejecting live listeners on the required ports.
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", port))
                if protocol == socket.SOCK_STREAM:
                    probe.listen(1)


def start(command, name, env=None):
    handle = (runtime / f"{name}.log").open("wb")
    handles.append(handle)
    process = subprocess.Popen(
        command, cwd=root, env=env, stdout=handle, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    processes.append(process)
    return process


def public_key(path):
    subprocess.run(
        ["solana-keygen", "new", "--silent", "--no-bip39-passphrase", "--outfile", str(path)],
        stdout=subprocess.DEVNULL, check=True, timeout=30,
    )
    return subprocess.check_output(
        ["solana-keygen", "pubkey", str(path)], text=True, timeout=10,
    ).strip()


def stop_owned(process):
    # Each process owns its session, including any surviving descendants.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def released_ports():
    deadline = time.monotonic() + 10
    while True:
        try:
            check_ports()
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned validator ports were not released after cleanup")
            time.sleep(0.2)
    print("PASS: all owned validator TCP/UDP ports released", flush=True)


def ready(validator):
    deadline = time.monotonic() + 60
    last_error = "not attempted"
    while time.monotonic() < deadline:
        if validator.poll() is not None:
            raise RuntimeError(f"Validator exited: {validator.returncode}")
        try:
            if rpc("getHealth") == "ok":
                break
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as error:
            last_error = str(error)
        time.sleep(0.5)
    else:
        raise RuntimeError(f"Validator readiness timeout: {last_error}")
    version = rpc("getVersion")
    assert version["solana-core"] == "4.1.2", version


def interrupted(signum, _frame):
    raise RuntimeError(f"Interrupted by signal {signum}")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

# Agave's test-validator CLI hardcodes wildcard RPC/faucet listeners. An
# unprivileged network namespace with only loopback makes all of them local.
# Check host ports first as well, so occupied host ports still cause failure.
if "--isolated-network" not in arguments:
    check_ports()
    os.environ["INITIALIZATION_PARENT_NET"] = os.readlink("/proc/self/ns/net")
    os.execvp("unshare", [
        "unshare", "--user", "--map-root-user", "--net", "--",
        "python3", str(Path(__file__).resolve()), "--isolated-network", *(["--cancelled-rollback"] if cancelled_rollback_mode else ["--cancelled"] if cancelled_mode else ["--filled-rollback"] if rollback_mode else ["--filled"] if filled_mode else ["--cancellation"] if cancellation_mode else ["--orders"] if orders_mode else []),
    ])
if os.readlink("/proc/self/ns/net") == os.environ.get("INITIALIZATION_PARENT_NET"):
    raise SystemExit("The initialization runner requires its own network namespace")
if [name for _, name in socket.if_nameindex()] != ["lo"]:
    raise SystemExit("The initialization namespace must contain only loopback")
subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=10)
print("PASS: fresh network namespace contains only loopback; host ports were free", flush=True)
(root / ".runtime").mkdir(exist_ok=True)
runtime = Path(tempfile.mkdtemp(prefix="initialization-", dir=root / ".runtime"))
try:
    check_ports()
    authority_path = runtime / "deployment-authority.json"
    authority = public_key(authority_path)
    unrelated = public_key(runtime / "unrelated-program.json")
    config = runtime / "solana.yml"
    config.write_text(
        "json_rpc_url: http://127.0.0.1:18899\n"
        "websocket_url: ws://127.0.0.1:18900\n"
        f"keypair_path: {authority_path}\ncommitment: finalized\n"
    )
    validator = start([
        "solana-test-validator", "--quiet", "--config", str(config),
        "--ledger", str(runtime / "ledger"), "--bind-address", "127.0.0.1",
        "--rpc-port", "18899", "--faucet-port", "18901", "--gossip-port", "19010",
        "--dynamic-port-range", "19011-19040", "--ticks-per-slot", "8",
        "--mint", authority, "--limit-ledger-size", "10000",
        "--deactivate-feature", disable_legacy_deployment_feature,
        "--upgradeable-program", program_id, str(binary), authority,
        "--upgradeable-program", unrelated, str(binary), authority,
    ], "validator")
    ready(validator)
    print(f"Ready: isolated upgradeable SBF fixture; diagnostics: {runtime.relative_to(root)}", flush=True)
    env = os.environ.copy()
    env.update({
        "INITIALIZATION_RUNTIME": str(runtime),
        "INITIALIZATION_UNRELATED_PROGRAM": unrelated,
    })
    # The runner owns phase selection; callers cannot select arbitrary snapshots.
    env.pop("FILLED_ROLLBACK_PHASE", None)
    env.pop("CANCELLED_ROLLBACK_PHASE", None)
    suites = [("initialization", "test:initialization")]
    if orders_mode:
        suites.append(("orders", "test:orders"))
    if cancellation_mode:
        suites.append(("cancellation", "test:cancellation"))
    if filled_mode:
        suites.append(("filled", "test:filled"))
    if cancelled_mode:
        suites.append(("cancelled", "test:cancelled"))
    def run_suite(name, npm_script):
        tests = start(["npm", "--prefix", "harness", "run", npm_script], "tests" if name == "initialization" else name, env)
        deadline = time.monotonic() + 900
        while tests.poll() is None and time.monotonic() < deadline:
            if validator.poll() is not None:
                raise RuntimeError(f"Validator exited during {name}: {validator.returncode}")
            time.sleep(0.5)
        if tests.poll() is None:
            raise RuntimeError(f"{name} tests exceeded the 900-second deadline")
        print((runtime / ("tests.log" if name == "initialization" else f"{name}.log")).read_text(), flush=True)
        if tests.returncode != 0:
            raise RuntimeError(f"{name} tests failed: {tests.returncode}")

    for name, npm_script in suites:
        run_suite(name, npm_script)

    if rollback_mode:
        env[rollback_phase] = "prepare"
        run_suite(f"{rollback_name}-prepare", f"test:{rollback_name}:prepare")
        manifest = json.loads((runtime / f"{rollback_prefix}-manifest.json").read_text())
        original_dir = runtime / f"{rollback_prefix}-original"
        altered_dir = runtime / f"{rollback_prefix}-altered"
        original_dir.mkdir()
        altered_dir.mkdir()
        originals = {}
        altered = {}
        for address in manifest["keys"]:
            # CLI JSON is the pinned validator's supported account-dump format;
            # Python preserves exact u64 metadata (including rentEpoch).
            dump = json.loads(subprocess.check_output([
                "solana", "--config", str(config), "--commitment", "finalized",
                "account", address, "--output", "json",
            ], text=True, timeout=30))
            assert dump["pubkey"] == address
            assert dump["account"]["data"][1] == "base64"
            originals[address] = dump
            (original_dir / f"{address}.json").write_text(json.dumps(dump) + "\n")
            copy = json.loads(json.dumps(dump))
            data = bytearray(base64.b64decode(copy["account"]["data"][0], validate=True))
            if address in (manifest["escrow"], manifest["cashMint"]):
                offset = 64 if address == manifest["escrow"] else 36
                value = int.from_bytes(data[offset:offset + 8], "little")
                if address == manifest["escrow"]:
                    assert value == 10_000_000
                assert value > 0
                data[offset:offset + 8] = (value - 1).to_bytes(8, "little")
                copy["account"]["data"][0] = base64.b64encode(data).decode()
            altered[address] = copy
            (altered_dir / f"{address}.json").write_text(json.dumps(copy) + "\n")

        changed = [address for address in originals if originals[address] != altered[address]]
        assert set(changed) == {manifest["escrow"], manifest["cashMint"]}
        changes = []
        for address in changed:
            before = originals[address]
            after = altered[address]
            offset = 64 if address == manifest["escrow"] else 36
            original_bytes = base64.b64decode(before["account"]["data"][0])
            altered_bytes = base64.b64decode(after["account"]["data"][0])
            expected = bytearray(original_bytes)
            value = int.from_bytes(original_bytes[offset:offset + 8], "little")
            expected[offset:offset + 8] = (value - 1).to_bytes(8, "little")
            assert altered_bytes == expected
            restored_dump = json.loads(json.dumps(after))
            restored_dump["account"]["data"] = before["account"]["data"]
            assert restored_dump == before, "No other account field may change"
            changes.append({"address": address, "offset": offset, "original": str(value), "altered": str(value - 1)})
        conservation_checks = []
        for dumps in (originals, altered):
            for mint in (manifest["cashMint"], manifest["yesMint"]):
                # Decode the public key locally without another dependency.
                number = 0
                alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
                for character in mint:
                    number = number * 58 + alphabet.index(character)
                mint_key_bytes = number.to_bytes(32, "big")
                total = 0
                for dump in dumps.values():
                    data = base64.b64decode(dump["account"]["data"][0])
                    if dump["account"]["owner"] == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" and len(data) == 165:
                        if data[:32] == mint_key_bytes:
                            total += int.from_bytes(data[64:72], "little")
                supply = int.from_bytes(base64.b64decode(dumps[mint]["account"]["data"][0])[36:44], "little")
                assert total == supply, "All exported token balances must reconcile with supply"
                conservation_checks.append({"snapshot": "original" if dumps is originals else "altered",
                                            "mint": mint, "supply": str(supply), "sum": str(total)})
        evidence_path = runtime / f"{rollback_name}-evidence.json"
        evidence = json.loads(evidence_path.read_text())
        evidence["genesisAlterations"] = changes
        evidence["dumpFormat"] = "Pinned solana account --output json; exact u64 metadata preserved"
        if cancelled_rollback_mode:
            evidence["genesisConservation"] = conservation_checks
            for change in changes:
                address = change["address"]
                before = base64.b64decode(originals[address]["account"]["data"][0])
                after = base64.b64decode(altered[address]["account"]["data"][0])
                change["byteDifferences"] = [{"offset": i, "before": a, "after": b}
                                              for i, (a, b) in enumerate(zip(before, after)) if a != b]
                change["otherBytesAndMetadataUnchanged"] = True
            evidence["ledgers"] = [{"phase": "prepare", "path": str(runtime / "ledger"),
                                    "genesisHash": rpc("getGenesisHash")}]

        evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        print("PASS: retained original dumps; altered only escrow amount and cash supply by one unit; both mints conserve balances", flush=True)
        for process in reversed(processes):
            stop_owned(process)
        processes.clear()
        released_ports()
        ledger = runtime / f"{rollback_prefix}-ledger"
        assert not ledger.exists(), "Genesis loading requires a genuinely new ledger"
        # The default genesis faucet uses the CLI keypair and would overwrite
        # the exported cash-authority SOL balance. Use an unrelated identity.
        rollback_faucet = public_key(runtime / f"{rollback_prefix}-genesis-faucet.json")
        assert rollback_faucet not in manifest["keys"]
        command = [
            "solana-test-validator", "--quiet", "--config", str(config),
            "--ledger", str(ledger), "--bind-address", "127.0.0.1",
            "--rpc-port", "18899", "--faucet-port", "18901", "--gossip-port", "19010",
            "--dynamic-port-range", "19011-19040", "--ticks-per-slot", "8",
            "--mint", rollback_faucet,
            "--limit-ledger-size", "10000", "--deactivate-feature", disable_legacy_deployment_feature,
        ]
        for address in manifest["keys"]:
            command.extend(["--account", address, str(altered_dir / f"{address}.json")])
        validator = start(command, f"{rollback_prefix}-validator")
        ready(validator)
        if cancelled_rollback_mode:
            evidence = json.loads(evidence_path.read_text())
            genesis_hash = rpc("getGenesisHash")
            assert genesis_hash != evidence["ledgers"][0]["genesisHash"]
            evidence["ledgers"].append({"phase": "verify", "path": str(ledger), "genesisHash": genesis_hash,
                                        "genesisFaucet": rollback_faucet, "freshLedger": True})
            evidence["preparationCleanup"] = {"ownedProcessesStopped": True, "portsReleased": True}
            evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        print("Ready: second fresh ledger loaded immutable executable/ProgramData snapshots", flush=True)
        env[rollback_phase] = "verify"
        run_suite(f"{rollback_name}-verify", f"test:{rollback_name}:verify")

finally:
    # Each process has its own session; terminate its descendants as well as its leader.
    for process in reversed(processes):
        stop_owned(process)
    for handle in handles:
        handle.close()
    print(f"Owned processes stopped; diagnostics preserved in {runtime.relative_to(root)}", flush=True)
    # Do not check/release anyone else's ports if the initial occupancy check failed.
    if processes:
        released_ports()
        if cancelled_rollback_mode:
            evidence_path = runtime / "cancelled-rollback-evidence.json"
            if evidence_path.is_file():
                evidence = json.loads(evidence_path.read_text())
                evidence["finalCleanup"] = {"ownedProcessesStopped": True, "portsReleased": True}
                evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
