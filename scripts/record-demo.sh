#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  -h|--help)
    if (( $# != 1 )); then echo 'ERROR: --help takes no other arguments.' >&2; exit 2; fi
    cat <<'HELP'
Usage: bash scripts/record-demo.sh [--help]
Record the actual interactive CLI: Filled alone or both fresh local scenarios.
Requires the demo's existing tools/permissions plus optional VHS >= 0.12.1,
ttyd >= 1.7.2, FFmpeg/ffprobe, Chrome/Chromium, fontconfig and DejaVu Sans Mono.
Optional local tools may live in .local/recording/bin; nothing is installed.
Preserves original GIF, screenshots, transcript, versions and validation in a
new ignored .runtime/record-demo-* directory. Replaces docs/assets/demo.gif
atomically only after successful execution, evidence and media validation.
Long waiting periods are omitted using VHS Hide/Show and bounded screen waits.
HELP
    exit 0 ;;
  '') if (( $# != 0 )); then echo 'ERROR: no positional arguments accepted.' >&2; exit 2; fi ;;
  *) echo 'Usage: bash scripts/record-demo.sh [--help]' >&2; exit 2 ;;
esac

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PATH="$PWD/.local/recording/bin:$PATH"
command -v python3 >/dev/null || { echo 'ERROR: Python 3 is required.' >&2; exit 1; }
exec python3 - <<'PY'
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

root = Path.cwd()
interruption = None

def interrupted(signum, _frame):
    global interruption
    interruption = interruption or signum

for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, interrupted)

def require(condition, message):
    if not condition:
        raise ValueError(message)

def run(command, **kwargs):
    return subprocess.check_output(command, text=True, timeout=30,
                                   stderr=subprocess.STDOUT, **kwargs).strip()

def processes():
    result = {}
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            fields = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
            if fields[0] != 'Z':
                args = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                result[int(directory.name)] = (int(fields[1]), fields[19], args)
        except (OSError, IndexError):
            pass
    return result

def status(code):
    return code if code >= 0 else 128 - code

def reap_adopted():
    # Leave Popen's direct child to Popen, but promptly reap adopted workers so
    # runner process-group checks do not mistake zombies for surviving work.
    children = Path(f'/proc/self/task/{os.getpid()}/children').read_text().split()
    for child in map(int, children):
        if recorder is None or child != recorder.pid:
            try:
                os.waitpid(child, os.WNOHANG)
            except ChildProcessError:
                pass

session = None
recorder = None
owned = {}
report = {'status': 'failed'}
code = 1
try:
    for tool in ('vhs', 'ttyd', 'ffmpeg', 'ffprobe', 'fc-match', 'bash', 'stty'):
        require(shutil.which(tool), f'Missing optional recording prerequisite: {tool}')
    versions = {tool: run([tool, flag]).splitlines()[0] for tool, flag in
                (('vhs', '--version'), ('ttyd', '--version'), ('ffmpeg', '-version'),
                 ('ffprobe', '-version'), ('bash', '--version'), ('python3', '--version'))}
    versions['fontconfig'] = run(['fc-match', '-V'])
    vhs_version = re.search(r'v(\d+)\.(\d+)\.(\d+)', versions['vhs'])
    require(vhs_version and tuple(map(int, vhs_version.groups())) >= (0, 12, 1),
            'VHS >= 0.12.1 is required for this tape (including Columns/Rows).')
    ttyd_version = re.search(r'(\d+)\.(\d+)\.(\d+)', versions['ttyd'])
    require(ttyd_version and tuple(map(int, ttyd_version.groups())) >= (1, 7, 2),
            'ttyd >= 1.7.2 is required by VHS.')
    browser = next((shutil.which(name) for name in
                    ('chromium', 'chromium-browser', 'google-chrome', 'chrome') if shutil.which(name)), None)
    require(browser, 'Chrome/Chromium must be available on PATH; automatic downloads are disabled by this check.')
    versions['browser'] = run([browser, '--version'])
    versions['font'] = run(['fc-match', '-f', '%{family}', 'DejaVu Sans Mono'])
    require(versions['font'] == 'DejaVu Sans Mono', 'Install DejaVu Sans Mono separately before recording.')
    print(json.dumps(versions, indent=2), flush=True)
    # Adopt/reap recorder orphans without touching unrelated host processes.
    require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'Linux child subreaper setup failed.')
    (root / '.runtime').mkdir(exist_ok=True)
    session = Path(tempfile.mkdtemp(prefix='record-demo-', dir=root / '.runtime'))
    print(f'Recording artifacts: {session.relative_to(root)}', flush=True)
    (session / 'versions.json').write_text(json.dumps(versions, indent=2) + '\n')
    # Prompt instrumentation records the real command exit code and terminal
    # settings; it never changes the CLI, its output or its scenario inputs.
    (session / 'terminal-init.sh').write_text('''
PS1='$ '
printf '%s\\n' "$$" > "$RECORD_DEMO_SESSION/shell.pid"
stty -g > "$RECORD_DEMO_SESSION/terminal-before.txt"
record_demo_prompt() {
  local result=$?
  if [[ ${record_demo_armed:-0} == 1 ]]; then
    printf '%s\\n' "$result" > "$RECORD_DEMO_SESSION/cli-exit-code.txt"
    stty -g > "$RECORD_DEMO_SESSION/terminal-after.txt"
    unset PROMPT_COMMAND
  else
    record_demo_armed=1
  fi
}
PROMPT_COMMAND=record_demo_prompt
clear
''')
    tape = (root / 'docs/demo.tape').read_text()
    # Only output locations change. The checked-in interactions are exact.
    tape = re.sub(r'^(Output|Screenshot) (.+)$',
                  lambda m: f'{m[1]} "{session / m[2]}"', tape, flags=re.M)
    (session / 'recording.tape').write_text(tape)
    run(['vhs', 'validate', str(session / 'recording.tape')])
    env = os.environ.copy()
    env['RECORD_DEMO_SESSION'] = str(session)
    env.pop('NO_COLOR', None)
    env['TERM'] = 'xterm-256color'
    started = time.time_ns()
    preexisting = {p.name for p in (root / '.runtime').iterdir()}
    with (session / 'vhs.log').open('wb') as log:
        recorder = subprocess.Popen(['vhs', str(session / 'recording.tape')], env=env,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 6500
        while recorder.poll() is None:
            reap_adopted()
            snapshot = processes()
            parents = {os.getpid(), recorder.pid, *owned}
            for _ in range(4):
                for pid, (parent, identity, args) in snapshot.items():
                    if parent in parents and pid != os.getpid():
                        owned[pid] = (identity, args)
                        parents.add(pid)
            exit_file = session / 'cli-exit-code.txt'
            if exit_file.exists() and int(exit_file.read_text()) != 0:
                code = int(exit_file.read_text())
                raise ValueError(f'Interactive CLI failed with exit code {code}.')
            if interruption or time.monotonic() >= deadline:
                if not interruption:
                    raise ValueError('Recording exceeded the 6500s overall deadline.')
                break
            time.sleep(0.1)
        code = 128 + interruption if interruption else status(recorder.returncode)
    # A media tool failure must not hide the actual CLI failure.
    exit_file = session / 'cli-exit-code.txt'
    if exit_file.exists() and int(exit_file.read_text()) != 0 and not interruption:
        code = int(exit_file.read_text())
    require(code == 0, f'Recorder/CLI failed with exit code {code}; see vhs.log.')
    require(exit_file.exists() and int(exit_file.read_text()) == 0, 'Missing successful interactive CLI exit.')
    require((session / 'terminal-before.txt').read_text() == (session / 'terminal-after.txt').read_text(),
            'The CLI did not restore terminal settings.')
    summaries = [p for p in (root / '.runtime').glob('demo-ui-*/ui-summary.json')
                 if p.parent.name not in preexisting and p.stat().st_mtime_ns >= started]
    require(len(summaries) == 1, 'Expected exactly one current-run interactive summary.')
    summary_path = summaries[0]
    summary = json.loads(summary_path.read_text())
    require(summary['status'] == 'passed' and summary['exitCode'] == 0 and
            [r['recoveredTerminalOutcome'] for r in summary['scenarios']] in
            (['Filled'], ['Filled', 'Cancelled']),
            'Filled alone or both interactive scenarios must complete successfully.')
    spec = importlib.util.spec_from_file_location('demo_validation', root / 'scripts/run-demo.py')
    demo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(demo)
    transcript = (session / 'terminal.txt').read_text()
    for result, scenario in zip(summary['scenarios'], demo.SCENARIOS):
        require(result == demo.summarize(root / result['freshDeployment'], root / result['logs'][0], scenario, 0),
                'Current-run evidence differs from the CLI summary.')
        visible = [f"VERIFIED / {result['recoveredTerminalOutcome']}",
                   f"Source lifecycle: {result['finalSourceState']}",
                   f"Finalized delivery slot: {result['finalizedSolanaDeliverySlot']}",
                   'Recovery decision: Complete; further submissions=0',
                   'Cleanup: owned processes stopped=True; ports released=True']
        for key, label in (('userCash', 'User cash'), ('escrow', 'Escrow cash'),
                           ('executorCash', 'Executor cash'), ('userYes', 'User YES')):
            whole, fraction = divmod(int(result['sourceBalancesBaseUnits'][key]), 1_000_000)
            visible.append(f'{label}: {whole}.{fraction:06d} mock ' + ('YES' if key == 'userYes' else 'USD'))
        for key, value in result['accountingBaseUnits'].items():
            whole, fraction = divmod(int(value), 1_000_000)
            visible.append(f'{key}: {whole}.{fraction:06d} mock ' + ('YES' if key == 'issued' else 'USD'))
        require(all(row in transcript for row in visible), 'Recorded text is missing verified result fields.')
    require(len({r['freshDeployment'] for r in summary['scenarios']}) == len(summary['scenarios']),
            'Deployments must be separate.')
    screenshots = ['menu', 'filled-running', 'filled', 'evidence', 'completed']
    if len(summary['scenarios']) == 2:
        screenshots += ['cancelled-running', 'cancelled', 'previous-result', 'next-result']
    else:
        screenshots += [f'story-{number:02d}' for number in range(1, 7)]
    for name in screenshots:
        require((session / f'{name}.png').stat().st_size > 0, f'Missing screenshot: {name}')
    raw = session / 'raw.gif'
    media = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(raw)]))
    stream = media['streams'][0]
    duration = float(media['format']['duration'])
    require(stream['codec_name'] == 'gif' and stream['width'] >= 1000 and stream['height'] >= 700
            and 25 <= duration <= 65, 'Unexpected GIF format, dimensions or duration.')
    run(['ffmpeg', '-v', 'error', '-i', str(raw), '-f', 'null', '-'])
    report.update(status='passed', cliExitCode=0, terminalRestored=True,
                  summary=str(summary_path.relative_to(root)), media=media,
                  gifBytes=raw.stat().st_size, wallSeconds=(time.time_ns() - started) / 1e9)
    code = 0
except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
    print(f'ERROR: {error}', file=sys.stderr, flush=True)
    report['failure'] = str(error)
    code = code or 1
finally:
    # First ask the CLI/runner supervisors to finish their owned node cleanup.
    # Match captured PID start times to avoid signalling a recycled PID.
    snapshot = processes()
    for pid, (identity, args) in owned.items():
        if pid in snapshot and snapshot[pid][1] == identity and any(name in args for name in
                ('scripts/run-demo-ui.py', 'scripts/check-dual-chain-setup.py')):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    cleanup_deadline = time.monotonic() + 90
    while any(pid in (current := processes()) and current[pid][1] == identity
              and any(name in args for name in ('scripts/run-demo-ui.py', 'scripts/check-dual-chain-setup.py'))
              for pid, (identity, args) in owned.items()) and time.monotonic() < cleanup_deadline:
        reap_adopted()
        time.sleep(0.2)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        snapshot = processes()
        for pid, (identity, _) in owned.items():
            if pid in snapshot and snapshot[pid][1] == identity:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        time.sleep(0.3)
    if recorder:
        recorder.wait(timeout=10)
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
        except ChildProcessError:
            break
    snapshot = processes()
    survivors = [pid for pid, (identity, _) in owned.items() if pid in snapshot and snapshot[pid][1] == identity]
    report['ownedProcessesStopped'] = not survivors
    report['survivingOwnedPids'] = survivors
    if survivors:
        report['status'] = 'failed'
        code = code or 1
    if interruption:
        report['status'] = 'failed'
        code = 128 + interruption
    # An interruption during final checks also prevents public replacement.
    report['exitCode'] = code
    if session:
        before, after = (session / f'terminal-{name}.txt' for name in ('before', 'after'))
        report['terminalRestored'] = before.exists() and after.exists() and before.read_text() == after.read_text()
        exit_file = session / 'cli-exit-code.txt'
        if exit_file.exists():
            report['cliExitCode'] = int(exit_file.read_text())
        (session / 'validation.json').write_text(json.dumps(report, indent=2) + '\n')
        if code == 0:
            destination = root / 'docs/assets/demo.gif'
            destination.parent.mkdir(exist_ok=True)
            # Copy to the same filesystem, then atomically replace the public GIF.
            with tempfile.NamedTemporaryFile(dir=session, suffix='.gif', delete=False) as candidate:
                candidate.write((session / 'raw.gif').read_bytes())
            os.replace(candidate.name, destination)
            print(f'Validated GIF: {destination.relative_to(root)} ({report["gifBytes"]} bytes)', flush=True)
        print(f'Exit code: {code}; preserved artifacts: {session.relative_to(root)}', flush=True)
sys.exit(code)
PY
