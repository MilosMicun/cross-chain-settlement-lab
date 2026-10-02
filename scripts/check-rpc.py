#!/usr/bin/env python3
"""Bounded loopback RPC health checks; no program deployment or transactions."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root = Path(os.environ["LAB_ROOT"])
(root / ".runtime").mkdir(exist_ok=True)
runtime = Path(tempfile.mkdtemp(prefix="rpc-", dir=root / ".runtime"))
logs = root / ".local/logs"
logs.mkdir(parents=True, exist_ok=True)
# Never use a proxy or public RPC for these local checks.
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
processes = []
handles = []


def rpc(port, method):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": []})
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}",
        data=body.encode(),
        headers={"Content-Type": "application/json"},
    )
    with http.open(request, timeout=2) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(f"{method}: {result['error']}")
    return result["result"]


def start(command, name):
    handle = (runtime / f"{name}.log").open("wb")
    handles.append(handle)
    process = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT)
    processes.append(process)
    return process


def wait_rpc(process, port, method, timeout=60):
    deadline = time.monotonic() + timeout
    last_error = "not attempted"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{method}: process exited with {process.returncode}")
        try:
            return rpc(port, method)
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as error:
            last_error = str(error)
        time.sleep(0.5)
    raise RuntimeError(f"{method}: startup timeout; {last_error}")


try:
    # Fail on occupied ports rather than connecting to or stopping another node.
    for port in [18545, 18899, 18900, 18901, *range(19010, 19041)]:
        for protocol in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            with socket.socket(socket.AF_INET, protocol) as probe:
                probe.bind(("127.0.0.1", port))

    keypair = runtime / "client-keypair.json"
    subprocess.run(
        ["solana-keygen", "new", "--silent", "--no-bip39-passphrase", "--outfile", str(keypair)],
        stdout=subprocess.DEVNULL,
        check=True,
    )
    public_key = subprocess.check_output(["solana-keygen", "pubkey", str(keypair)], text=True).strip()
    config = runtime / "solana.yml"
    config.write_text(
        "json_rpc_url: http://127.0.0.1:18899\n"
        "websocket_url: ws://127.0.0.1:18900\n"
        f"keypair_path: {keypair}\n"
        "commitment: finalized\n"
    )
    anvil = start(
        ["anvil", "--silent", "--host", "127.0.0.1", "--port", "18545", "--chain-id", "31337"],
        "anvil",
    )
    chain_id = wait_rpc(anvil, 18545, "eth_chainId")
    block = rpc(18545, "eth_blockNumber")
    assert int(chain_id, 16) == 31337
    assert int(block, 16) >= 0
    print(f"PASS: Anvil eth_chainId={chain_id} (31337), eth_blockNumber={block}", flush=True)

    validator = start(
        [
            "solana-test-validator", "--quiet", "--config", str(config),
            "--ledger", str(runtime / "ledger"), "--bind-address", "127.0.0.1",
            "--rpc-port", "18899", "--faucet-port", "18901",
            "--gossip-port", "19010", "--dynamic-port-range", "19011-19040",
            "--mint", public_key, "--limit-ledger-size", "10000",
        ],
        "solana-validator",
    )
    health = wait_rpc(validator, 18899, "getHealth")
    version = rpc(18899, "getVersion")
    assert health == "ok"
    assert version["solana-core"] == "4.1.2"
    print(f"PASS: Solana getHealth={health}, getVersion={json.dumps(version)}", flush=True)
    (logs / "rpc-evidence.json").write_text(json.dumps({
        "anvil": {"chainId": chain_id, "blockNumber": block},
        "solana": {"health": health, "version": version},
        "runtimeDirectory": str(runtime.relative_to(root)),
    }, indent=2) + "\n")
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    for handle in handles:
        handle.close()
    print(f"RPC processes stopped; diagnostics preserved in {runtime.relative_to(root)}", flush=True)
