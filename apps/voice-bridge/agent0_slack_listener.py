#!/usr/bin/env python3
"""Minimal Slack Socket Mode listener for Agent0."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import queue
import re
import signal
import sys
import time
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from array import array
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

import websocket


LOG = logging.getLogger("agent0-slack-listener")
STOP = False
WHISPER_MODEL = None
AUDIO_JOBS = queue.Queue()
VOICE_PAUSED = threading.Event()
VOICE_TARGET: tuple[str, str | None] | None = None
OPENCODE_LOCK = threading.Lock()
CLAUDE_LOCK = threading.Lock()
CLAUDE_SESSION_PREFIX = "claude-code-session-id"
SEEN_LOCK = threading.Lock()
STATE_DIR = Path("/home/kevin/.local/state/agent0-slack-listener")
SESSION_FILE = STATE_DIR / "opencode-session-id"
SEEN_FILE = STATE_DIR / "processed-slack-events"
OPENCODE_URL = os.environ.get("AGENT0_OPENCODE_URL", "http://127.0.0.1:4096")
OWNER_USER_ID = os.environ.get("SLACK_OWNER_USER_ID", "U0C3D8T0LE6")
SEEN_EVENTS: set[str] = set()
CONFIRM_CODE = "area 51"
PENDING_ACTION_TTL = 300
PENDING_ACTIONS: dict[tuple[str, str], tuple[float, str, bool]] = {}
PENDING_ACTIONS_LOCK = threading.Lock()


@dataclass(frozen=True)
class Settings:
    bot_token: str
    app_token: str
    bot_user_id: str
    allowed_channels: set[str]
    lab_channel: str


def load_env_file(path: str) -> None:
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key, value)


def slack_api(method: str, token: str, payload: dict[str, Any] | None = None, post: bool = False) -> dict[str, Any]:
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=data,
        headers=headers,
        method="POST" if payload is not None or post else "GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def json_request(method: str, url: str, payload: dict[str, Any] | None = None,
                 timeout: int = 120) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def load_seen_events() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if SEEN_FILE.exists():
        SEEN_EVENTS.update(line.strip() for line in SEEN_FILE.read_text(encoding="utf-8").splitlines() if line.strip())


def claim_event(event_id: str) -> bool:
    if not event_id:
        return True
    with SEEN_LOCK:
        if event_id in SEEN_EVENTS:
            return False
        SEEN_EVENTS.add(event_id)
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with SEEN_FILE.open("a", encoding="utf-8") as handle:
            handle.write(event_id + "\n")
        return True


def project_directory(channel: str | None) -> str | None:
    """Working directory for an action turn, by channel.

    AGENT0_PROJECT_DIRS maps "channel-id:/path,...". Unmapped channels get
    None (server default) instead of the old hardcoded supervisor repo, so
    BattleBuddy/ops turns no longer reason inside the wrong project.
    """
    raw = os.environ.get("AGENT0_PROJECT_DIRS", "")
    for item in raw.split(","):
        item = item.strip()
        if not item or ":" not in item or channel is None:
            continue
        chan, _, path = item.partition(":")
        if chan.strip() == channel and path.strip():
            return path.strip()
    return None


def opencode_session(directory: str | None = None) -> str:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # One session per working directory: reusing a supervisor-repo session
    # for a BattleBuddy turn was the wrong-project bug.
    session_file = SESSION_FILE
    if directory:
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", directory.strip("/"))
        session_file = STATE_DIR / f"opencode-session-id.{safe}"
    if session_file.exists():
        session_id = session_file.read_text(encoding="utf-8").strip()
        if session_id:
            try:
                json_request("GET", f"{OPENCODE_URL}/session/{session_id}", timeout=10)
                return session_id
            except Exception:
                LOG.warning("Stored OpenCode session is unavailable; creating a new one")
    payload: dict[str, Any] = {"title": "Agent0 live meeting bridge"}
    if directory:
        payload["directory"] = directory
    session = json_request(
        "POST", f"{OPENCODE_URL}/session",
        payload, timeout=15,
    )
    session_id = session["id"]
    session_file.write_text(session_id + "\n", encoding="utf-8")
    return session_id


def _claude_session_file(directory: str | None) -> Path:
    if not directory:
        return STATE_DIR / CLAUDE_SESSION_PREFIX
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", directory.strip("/"))
    return STATE_DIR / f"{CLAUDE_SESSION_PREFIX}.{safe}"


def _claude_once(
    prompt: str,
    directory: str | None,
    permission_flags: list[str],
    resume: str | None,
) -> tuple[str, str | None]:
    # Confirmed against Claude Code 2.1.282: --output-format json uses
    # result and session_id. Bash scopes as Bash(git *), not a bare Bash.
    cmd = [
        os.environ.get("AGENT0_CLAUDE_BIN", "claude"),
        "-p", prompt,
        "--output-format", "json",
        "--permission-prompts", "none",
        *permission_flags,
    ]
    if resume:
        cmd.extend(["--resume", resume])
    proc = subprocess.run(
        cmd,
        cwd=directory or None,
        capture_output=True,
        text=True,
        timeout=150,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed (exit {proc.returncode}): {proc.stderr.strip()[:500]}")
    payload = json.loads(proc.stdout)
    if payload.get("is_error"):
        raise RuntimeError(f"claude -p error: {str(payload.get('result') or '')[:500]}")
    answer = str(payload.get("result") or "").strip()
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        session_id = None
    return answer, session_id


def agent0_reply(message: str, action: bool = False, channel: str | None = None) -> str:
    # Shared ground truth the reasoning model would otherwise lack
    # (it has no repo or workstation context of its own).
    context = (
        "Live facts 2026-09-22: bridge audit lines ship (every reasoning turn "
        "ends heard/routed/outcome); listening in lab + standup channels; "
        "stay-awake is on (no auto lock); Battlebuddy recorder v3 with T1 "
        "tuner holds is live on Radiodesk; M9 #61 design merged (PR #62), "
        "build issue #63 open; owner merges, bots never merge."
    )
    if action:
        prompt = (
            "You are Agent0, Scrum Master for Rooted/OwnPlace, doing meeting work. "
            "The instruction comes from owner Kevin, or from Claude the consultant "
            "under Kevin's standing authorization for review and PR-open work. Do the stated "
            "work with tools now: reviewing code, reporting findings, and opening PRs from "
            "branches are expected. Hard nos — refuse with NEEDS-OWNER: merging anything, "
            "pushing to main, deploying, credentials, destructive operations. Start with ACTED "
            "only if a file or git state changed. If you only answered and changed nothing, "
            "start with ANSWERED. Use BLOCKED or NEEDS-OWNER when you refuse. Then concise evidence, max 6 sentences. Never write "
            "'bridge acknowledgement', 'timestamp report', or 'End turn'. "
            f"Context: {context} Meeting work order: {message}"
        )
        permission_flags = [
            "--permission-mode", "acceptEdits",
            "--allowedTools", "Read Edit Write Bash(git *) Bash(npm *) Bash(npx *)",
        ]
    else:
        prompt = (
            "You are Agent0, Scrum Master for Rooted/OwnPlace, replying in a live lab meeting. "
            "Kevin is owner; AgentGPT is CIO consultant; Radics is coder and organization owner. "
            "This turn is discussion-only: do not call tools or modify files, GitHub, credentials, "
            "deployments, or configuration. Reply naturally in at most 4 sentences. "
            "Do not prefix with any status label and do not end with 'End turn'. "
            "Do not repeat back what was said; add something new: an answer, "
            "a decision, or a question. Banned phrases — never write them: "
            "'bridge acknowledgement', 'timestamp report', 'no file changes', "
            "'no merges or deploys', 'workstation'. "
            f"Context: {context} Meeting turn: {message}"
        )
        permission_flags = [
            "--permission-mode", "dontAsk",
            "--allowedTools", "Read Grep Glob",
            "--disallowedTools", "Bash Edit Write",
        ]
    directory = project_directory(channel)
    session_file = _claude_session_file(directory)
    resume = session_file.read_text(encoding="utf-8").strip() if session_file.exists() else ""
    with CLAUDE_LOCK:
        try:
            answer, new_id = _claude_once(prompt, directory, permission_flags, resume or None)
        except Exception:
            if not resume:
                raise
            LOG.warning("Stored Claude session failed; retrying without resume")
            answer, new_id = _claude_once(prompt, directory, permission_flags, None)
        if new_id:
            session_file.parent.mkdir(parents=True, exist_ok=True)
            session_file.write_text(new_id + "\n", encoding="utf-8")
    if not answer:
        raise RuntimeError("Agent0 reasoning returned no text")
    return answer


def _prune_pending_actions(now: float) -> None:
    expired = [key for key, (deadline, _, _) in PENDING_ACTIONS.items() if deadline <= now]
    for key in expired:
        PENDING_ACTIONS.pop(key, None)


def request_action_confirmation(settings: Settings, channel: str, thread_ts: str | None,
                                instruction: str, action: bool) -> None:
    key = (channel, thread_ts or "")
    with PENDING_ACTIONS_LOCK:
        _prune_pending_actions(time.monotonic())
        PENDING_ACTIONS[key] = (time.monotonic() + PENDING_ACTION_TTL, instruction, action)
    post_message(
        settings,
        channel,
        "Confirmation required. Reply in this thread with @Agent0 Area 51 within five minutes to authorize this action. Nothing has been acted on yet.",
        thread_ts=thread_ts,
    )


def confirm_pending_action(settings: Settings, channel: str, thread_ts: str | None,
                           user: str | None) -> bool:
    if user != OWNER_USER_ID:
        post_message(settings, channel, "NEEDS-OWNER: only Kevin can confirm an Agent0 action.", thread_ts=thread_ts)
        return False
    key = (channel, thread_ts or "")
    now = time.monotonic()
    with PENDING_ACTIONS_LOCK:
        _prune_pending_actions(now)
        pending = PENDING_ACTIONS.pop(key, None)
    if pending is None:
        post_message(settings, channel, "No pending Agent0 action matched this confirmation.", thread_ts=thread_ts)
        return False
    _, instruction, action = pending
    threading.Thread(
        target=route_agent0_turn,
        args=(settings, channel, thread_ts, instruction, action),
        name="agent0-confirmed-reasoning",
        daemon=True,
    ).start()
    return True


def post_message(settings: Settings, channel: str, text: str, thread_ts: str | None = None,
                 broadcast: bool = False) -> None:
    payload: dict[str, Any] = {"channel": channel, "text": text}
    if thread_ts:
        payload["thread_ts"] = thread_ts
        # Stand-up visibility: reasoning answers live in the thread but
        # must also surface in-channel, or nobody reads them.
        if broadcast:
            payload["reply_broadcast"] = True
    result = slack_api("chat.postMessage", settings.bot_token, payload)
    if not result.get("ok"):
        LOG.warning("chat.postMessage failed: %s", result.get("error"))


def speak_text(text: str, voice: str = "agent0") -> bool:
    """Speak through Agent0's local audio output."""
    safe_text = text.strip()
    if not safe_text:
        return False
    if len(safe_text) > 600:
        safe_text = safe_text[:600] + "..."

    piper = "/home/kevin/.local/share/agent0-slack-listener/.venv/bin/piper"
    models = {
        "agent0": "/home/kevin/.local/share/agent0-slack-listener/voices/en_US-amy-low/en_US-amy-low.onnx",
        "codex": "/home/kevin/.local/share/agent0-slack-listener/voices/en_US-ryan-low/en_US-ryan-low.onnx",
        "claude": "/home/kevin/.local/share/agent0-slack-listener/voices/en_GB-alan-low/en_GB-alan-low.onnx",
    }
    model = models.get(voice, models["agent0"])
    if os.path.exists(piper) and os.path.exists(model):
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", prefix="agent0-voice-", delete=False) as wav:
                wav_path = wav.name
            subprocess.run(
                [piper, "-m", model, "-f", wav_path],
                input=safe_text + "\n",
                text=True,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=45,
            )
            subprocess.run(
                ["pw-play", wav_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=180,
            )
            try:
                os.unlink(wav_path)
            except OSError:
                pass
            return True
        except Exception as exc:
            LOG.warning("Piper speech failed: %s", exc)

    html = f"""<!doctype html>
<meta charset="utf-8">
<title>Agent0 Voice</title>
<body style="font:20px sans-serif;padding:2rem">Agent0 speaking...</body>
<script>
const text = {safe_text!r};
function speak() {{
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 0.9;
  utterance.volume = 1;
  utterance.onend = () => setTimeout(() => window.close(), 500);
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}}
setTimeout(speak, 500);
</script>
"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", prefix="agent0-voice-", delete=False, encoding="utf-8") as handle:
        handle.write(html)
        uri = "file://" + handle.name

    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")
    env.setdefault("WAYLAND_DISPLAY", "wayland-1")
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/1000")
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
    try:
        subprocess.Popen(
            ["chromium", "--new-window", f"--app={uri}"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except Exception as exc:
        LOG.warning("Unable to launch browser speech: %s", exc)
        return False


def parse_listen_seconds(message: str) -> int:
    match = re.search(r"\b(\d{1,3})\b", message)
    if not match:
        return 90
    return max(8, min(180, int(match.group(1))))


def record_audio(seconds: int) -> str:
    source = os.environ.get("SLACK_MIC_SOURCE", "alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.mono-fallback")
    with tempfile.NamedTemporaryFile(suffix=".wav", prefix="agent0-listen-", delete=False) as wav:
        wav_path = wav.name
    subprocess.run(
        ["timeout", "--signal=INT", str(seconds), "pw-record", "--media-category", "Capture", "--target", source, wav_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=seconds + 5,
    )
    return wav_path


def transcribe_audio(path: str) -> str:
    global WHISPER_MODEL
    if WHISPER_MODEL is None:
        from faster_whisper import WhisperModel

        WHISPER_MODEL = WhisperModel(
            os.environ.get("SLACK_STT_MODEL", "tiny.en"),
            device="cpu",
            compute_type="int8",
            download_root="/home/kevin/.local/share/agent0-slack-listener/whisper-models",
        )
    segments, _info = WHISPER_MODEL.transcribe(
        path,
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
        no_speech_threshold=0.8,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def end_turn_seen(text: str) -> bool:
    lower = text.lower()
    return bool(
        re.search(r"\bend\s+turns?\b", lower)
        or re.search(r"\bin\s+turn\b", lower)
        or re.search(r"\benter\b", lower)
        or re.search(r"\bend\s+term\b", lower)
        or re.search(r"\bend\s+time\b", lower)
        or re.search(r"\band\s+turn\b", lower)
        or re.search(r"\bintern\b", lower)
    )


def remove_end_turn(text: str) -> str:
    text = re.sub(r"\bend\s+turns?\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bin\s+turn\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\benter\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bend\s+term\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bend\s+time\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\band\s+turn\b[.!?]?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bintern\b[.!?]?", "", text, flags=re.IGNORECASE)
    return text.strip()


def wake_phrase_seen(text: str) -> bool:
    return bool(re.search(r"\b(?:break\s+in|breakin|breaking)\b", text, flags=re.IGNORECASE))


def _bt_sink() -> str | None:
    # Prefer an explicit Bluetooth output: the default route proved
    # unreliable for the ready tone even with the BT sink defaulted.
    # Falls back to default (no --target) when no BT sink exists, so a
    # re-paired/renamed device never silences the beep entirely.
    try:
        out = subprocess.run(["pactl", "list", "short", "sinks"], capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    for line in (out.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("bluez_output."):
            return parts[1]
    return None


def play_ready_tone() -> None:
    # Loud two-tone attention beep (#55): near-full-scale 880Hz then 1320Hz,
    # 0.35s each. The old single 0.4s blip at 37% was inaudible next to
    # normal desktop audio at the same sink volume.
    with tempfile.NamedTemporaryFile(suffix=".wav", prefix="agent0-ready-") as tone:
        with wave.open(tone.name, "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            samples = array("h")
            for freq, count in ((880, 5600), (1320, 5600)):
                samples.extend(
                    int(30000 * math.sin(2 * math.pi * freq * i / 16000)) for i in range(count)
                )
            if sys.byteorder != "little":
                samples.byteswap()
            wav.writeframes(samples.tobytes())
        bt_target = _bt_sink()
        tone_cmd = ["pw-play"] + (["--target", bt_target] if bt_target else []) + [tone.name]
        subprocess.run(tone_cmd, check=True, timeout=5,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def play_end_tone() -> None:
    # Audible end-turn confirmation (#55): descending 1320Hz then 660Hz,
    # 0.25s each — distinct from the ascending ready beep. Same routing.
    with tempfile.NamedTemporaryFile(suffix=".wav", prefix="agent0-end-") as tone:
        with wave.open(tone.name, "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            samples = array("h")
            for freq, count in ((1320, 4000), (660, 4000)):
                samples.extend(
                    int(30000 * math.sin(2 * math.pi * freq * i / 16000)) for i in range(count)
                )
            if sys.byteorder != "little":
                samples.byteswap()
            wav.writeframes(samples.tobytes())
        bt_target = _bt_sink()
        tone_cmd = ["pw-play"] + (["--target", bt_target] if bt_target else []) + [tone.name]
        subprocess.run(tone_cmd, check=True, timeout=5,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def listen_until_end_turn(max_seconds: int, pending=None) -> tuple[str, int, bool]:
    started = time.monotonic()
    chunks: list[str] = []
    heard_end_turn = False
    activated = False
    previous_tail = ""
    # Silence-timeout (#55): a turn with nobody speaking must not squat the
    # floor for the full window. After this many consecutive empty chunks
    # post-activation, close the turn as incomplete (status posted, nothing
    # acted on). 5 chunks ≈ 40s — long enough for thinking pauses.
    silent_chunks = 0
    SILENCE_LIMIT = 5

    while not STOP and time.monotonic() - started < max_seconds and not heard_end_turn:
        if VOICE_PAUSED.is_set() or (not activated and pending and pending()):
            return "", 0, False
        remaining = max_seconds - int(time.monotonic() - started)
        chunk_seconds = max(2, min(8 if activated else 3, remaining))
        wav_path = record_audio(chunk_seconds)
        try:
            chunk = transcribe_audio(wav_path)
        finally:
            os.unlink(wav_path)
        if chunk:
            LOG.info("Voice transcript chunk (%s): %r", "active" if activated else "wake", chunk)
        if STOP or VOICE_PAUSED.is_set():
            return "", 0, False
        if not activated:
            if pending and pending():
                return "", 0, False
            candidate = " ".join(filter(None, (previous_tail, chunk)))
            words = chunk.split()
            previous_tail = words[-1] if words else ""
            if not wake_phrase_seen(candidate):
                continue
            activated = True
            started = time.monotonic()
            play_ready_tone()
            LOG.info("Voice floor: owner turn opened after ready tone")
            # Discard the activation chunk; the ready tone opens a clean turn.
            continue
        if chunk:
            chunks.append(chunk)
            silent_chunks = 0
            heard_end_turn = end_turn_seen(chunk) or end_turn_seen(" ".join(chunks))
            if heard_end_turn:
                play_end_tone()
                LOG.info("Voice floor: end turn heard, down-beep played")
        elif activated:
            silent_chunks += 1
            if silent_chunks >= SILENCE_LIMIT:
                LOG.info("Voice floor: silence timeout, closing turn as incomplete")
                break

    elapsed = max(1, int(time.monotonic() - started))
    return remove_end_turn(" ".join(chunks)), elapsed, heard_end_turn


def captured_response(heard: str, complete: bool) -> tuple[str, str | None, str]:
    if not heard or not complete:
        # Never drop a turn silently (#54): the transcript shows the attempt.
        detail = "nothing heard" if not heard else "turn incomplete (no end turn)"
        return f"Voice turn captured with no usable speech ({detail}); nothing acted on.", None, "agent0"
    party = addressed_party(heard)
    reply = f"Owner voice turn addressed to **{party}**: `{heard}`"
    spoken = f"Message captured for {party}. End turn."
    return reply, spoken, "agent0"


def deliver_response(settings: Settings, channel: str, thread_ts: str | None,
                     reply: str, spoken: str | None, voice: str,
                     broadcast: bool = False) -> None:
    if spoken and not speak_text(spoken, voice=voice):
        reply += "\n\nVoice playback failed; text bridge is still online."
    if reply:
        post_message(settings, channel, reply, thread_ts=thread_ts, broadcast=broadcast)


def queue_demo_license(settings: Settings, channel: str, thread_ts: str | None) -> None:
    question = (
        "Kevin, what should Agent0 work on next? Reply in this thread with @Agent0 and your request. "
        "I will ask for the Area 51 confirmation before doing anything."
    )
    post_message(settings, channel, question, thread_ts=thread_ts)
    AUDIO_JOBS.put((settings, channel, thread_ts, "", question, "agent0"))


def queue_demo_standup(settings: Settings, channel: str, thread_ts: str | None) -> None:
    post_message(settings, channel, "Stand-up demo queued: Agent0, Claude, then AgentGPT.", thread_ts=thread_ts)
    for voice, spoken in DEMO_STANDUP_LINES:
        AUDIO_JOBS.put((settings, channel, thread_ts, "", spoken, voice))


def audio_worker(settings: Settings) -> None:
    # One worker owns recording and playback so neither can overlap the other.
    LOG.info("Voice standby active: waiting for break in")
    while not STOP:
        try:
            try:
                job = AUDIO_JOBS.get(timeout=0.2)
            except queue.Empty:
                job = None
            if job is not None:
                try:
                    deliver_response(*job)
                finally:
                    AUDIO_JOBS.task_done()
                continue
            if VOICE_PAUSED.is_set():
                continue
            target = VOICE_TARGET or (settings.lab_channel, None)
            heard, _elapsed, complete = listen_until_end_turn(
                180, pending=lambda: not AUDIO_JOBS.empty() or target != (VOICE_TARGET or (settings.lab_channel, None))
            )
            if STOP:
                break
            if not heard and not complete and not AUDIO_JOBS.empty():
                continue
            if heard and complete and re.search(r"\bdemo\s*stand[\s-]*up\b", heard, flags=re.IGNORECASE):
                queue_demo_standup(settings, target[0], target[1])
                continue
            if heard and complete and addressed_party(heard) == "Agent0":
                thread_ts = target[1]
                post_message(settings, target[0], f"Owner voice turn addressed to **Agent0**: `{heard}`", thread_ts=thread_ts)
                action_requested = bool(re.search(r"\bact\b", heard, flags=re.IGNORECASE))
                instruction = re.sub(r"^.*?\bact\b\s*[:,-]?\s*", "", heard, count=1, flags=re.IGNORECASE) if action_requested else heard
                status = "owner-authorized action" if action_requested else "discussion-only"
                post_message(settings, target[0], f"Agent0 received the voice turn. Status: {status}.", thread_ts=thread_ts)
                threading.Thread(
                    target=route_agent0_turn,
                    args=(settings, target[0], thread_ts, instruction, action_requested),
                    name="agent0-voice-reasoning",
                    daemon=True,
                ).start()
                continue
            reply, spoken, voice = captured_response(heard, complete)
            if reply:
                deliver_response(settings, target[0], target[1], reply, spoken, voice)
                LOG.info("Voice floor: turn delivered; waiting for break in")
        except Exception as exc:
            LOG.warning("Audio worker failed: %s", exc)
            time.sleep(2)


def addressed_party(text: str) -> str:
    lower = text.lower()
    if re.search(r"\b(agent\s*gpt|agentgpt|chat\s*gpt|chatgpt|codex)\b", lower):
        return "AgentGPT"
    if re.search(r"\b(agent\s*zero|agent0|agent\s*0)\b", lower):
        return "Agent0"
    return "All Agents"


def build_settings(env_path: str) -> Settings:
    load_env_file(env_path)
    bot_token = os.environ["SLACK_BOT_TOKEN"]
    app_token = os.environ["SLACK_APP_TOKEN"]
    lab_channel = os.environ["SLACK_AGENT0_LAB_CHANNEL"]
    raw_allowed = os.environ.get("SLACK_ALLOWED_CHANNELS", lab_channel)
    allowed_channels = {item.strip() for item in raw_allowed.split(",") if item.strip()}

    auth = slack_api("auth.test", bot_token)
    if not auth.get("ok"):
        raise RuntimeError(f"Slack auth.test failed: {auth.get('error')}")
    bot_user_id = auth["user_id"]
    return Settings(
        bot_token=bot_token,
        app_token=app_token,
        bot_user_id=bot_user_id,
        allowed_channels=allowed_channels,
        lab_channel=lab_channel,
    )


def clean_mention_text(text: str, bot_user_id: str) -> str:
    text = re.sub(rf"<@{re.escape(bot_user_id)}(?:\|[^>]+)?>\s*", "", text or "").strip()
    text = re.sub(r"<!here>\s*", "@here ", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"\s*\*Sent using\*.*$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    return re.sub(r"\s+", " ", text)


def response_for(message: str) -> tuple[str, str | None, str]:
    lower = message.lower().strip()
    if not lower or lower in {"help", "?"}:
        return (
            "Agent0 is online in lab mode. Try `status`, `standup`, or `blocker <text>`. "
            "Use `say <text>` for a voice test. I am only doing Slack coordination right now; opencode handoff comes next."
        ), None, "agent0"
    if lower.startswith("@here "):
        request = message[len("@here ") :].strip()
        spoken = "Room-wide request captured. AgentGPT should decide the next action."
        return f"Room-wide `@here` request captured for **All Agents**: `{request}`", spoken, "agent0"
    if lower.startswith("say "):
        spoken = message[4:].strip()
        if not spoken:
            return "Send `say <words>` and I will speak those words from the Agent0 workstation.", None, "agent0"
        return f"Speaking from Agent0: {spoken}", spoken, "agent0"
    if lower.startswith("codex say ") or lower.startswith("agentgpt say "):
        prefix = "codex say " if lower.startswith("codex say ") else "agentgpt say "
        spoken = message[len(prefix) :].strip()
        if not spoken:
            return "Send `agentgpt say <words>` and I will speak those words using the AgentGPT voice.", None, "codex"
        return f"Speaking as AgentGPT: {spoken}", spoken, "codex"
    if lower.startswith("listen") or lower.startswith("hear"):
        seconds = parse_listen_seconds(lower)
        try:
            heard, elapsed, heard_end_turn = listen_until_end_turn(seconds)
        except Exception as exc:
            LOG.warning("Listen/transcribe failed: %s", exc)
            # Audible failures still land in Slack (#54): never silent.
            return "Listen failed (mic or transcription error); nothing captured, nothing acted on.", None, "agent0"
        if not heard:
            return "Listen window heard no speech; nothing captured, nothing acted on.", None, "agent0"
        if not heard_end_turn:
            return f"Listen window captured speech but no end turn; held for review, nothing acted on: `{heard}`", None, "agent0"
        turn_note = "until End turn" if heard_end_turn else f"until the {seconds} second safety timeout"
        party = addressed_party(heard)
        if party == "AgentGPT":
            spoken = "AgentGPT was addressed. I captured the question and posted it for response."
            return f"I listened {turn_note}. Addressed to **AgentGPT**: `{heard}`", spoken, "agent0"
        if party == "Agent0":
            spoken = f"Agent0 heard: {heard}"
            return f"I listened {turn_note}. Addressed to **Agent0**: `{heard}`", spoken, "agent0"
        spoken = "Owner broadcast captured for all agents."
        return f"I listened {turn_note}. Owner broadcast to **All Agents**: `{heard}`", spoken, "agent0"
    if lower in {"voice", "voice status"}:
        spoken = "Agent0 voice channel is online. Kevin, ChatGPT, and OpenCode can now demo a spoken stand-up loop."
        return "Voice test launched on the Agent0 workstation.", spoken, "agent0"
    if lower.startswith("demo"):
        spoken = (
            "Good morning. Agent0 is acting as scrum master. Kevin is project owner. "
            "Codex is implementation lead. Today we are proving the communications loop."
        )
        return "Demo voice line launched on Agent0.", spoken, "agent0"
    if lower.startswith("status") or lower.startswith("ping"):
        return (
            "Agent0 Slack bridge is online. I can receive mentions over Socket Mode and reply here. "
            "Listening in lab + standup."
        ), None, "agent0"
    if lower.startswith("standup"):
        spoken = (
            "Stand-up check. Yesterday, today, blockers, decisions needed, and pull requests waiting."
        )
        return (
            "Stand-up shape: yesterday, today, blockers, decisions needed, PRs waiting. "
            "For now I can collect and reflect the prompt here; next step is wiring me into the project journal."
        ), spoken, "agent0"
    if lower.startswith("blocker"):
        detail = message[len("blocker") :].strip(" :-")
        if detail:
            spoken = f"Blocker noted. {detail}"
            return f"Blocker noted in lab: {detail}. Next step is to route blocker summaries to the stand-up lane.", spoken, "agent0"
        return "Send `blocker <what is blocked>` and I will echo it into the lab thread for now.", None, "agent0"
    return (
        "Received. I am in lab mode, so I will keep this contained here. "
        "Use `help` for the commands I can handle today."
    ), None, "agent0"


def is_builtin_command(message: str) -> bool:
    lower = message.lower().strip()
    return (
        not lower
        or lower in {"help", "?", "voice", "voice status", "voice pause", "mic off", "voice resume", "mic on"}
        or lower.startswith(("@here ", "say ", "codex say ", "agentgpt say ", "listen", "hear", "demo", "status", "ping", "standup", "blocker", "ask "))
    )


def audit_line(message: str, answer: str) -> str:
    # Bridge audit (#63 slice 1): every reasoning turn ends in a
    # `heard / routed-to / outcome + why` line. Spoken reply stays clean.
    first = (answer.strip().split("\n")[0] if answer.strip() else "").strip()
    upper = first.upper()
    if upper.startswith("ACTED"):
        outcome = "executed"
    elif upper.startswith("ANSWERED"):
        outcome = "answered"
    elif upper.startswith(("BLOCKED", "NEEDS-OWNER")):
        outcome = "blocked"
    else:
        outcome = "proposed"
    heard = message if len(message) <= 120 else message[:117] + "..."
    why = first if len(first) <= 160 else first[:157] + "..."
    return f'Bridge audit: heard="{heard}" → reasoning → {outcome}: {why}'


def relabel_unproven_acted(directory: str | None, answer: str) -> str:
    """ACTED is allowed only when git shows a change. Otherwise the label is ANSWERED."""
    lines = answer.splitlines() or [""]
    if not lines[0].upper().startswith("ACTED"):
        return answer
    changed = False
    if directory:
        try:
            r = subprocess.run(
                ["git", "-C", directory, "status", "--porcelain"],
                capture_output=True, text=True, timeout=20,
            )
            changed = r.returncode == 0 and any(ln.strip() for ln in r.stdout.splitlines())
        except Exception:
            changed = False
    if changed:
        return answer
    rest = lines[0][5:].lstrip(" :")
    lines[0] = f"ANSWERED: {rest}" if rest else "ANSWERED"
    return "\n".join(lines)


def verify_action(directory: str | None, answer: str) -> str:
    """Independent check on an ACTED claim before it is reported as done.

    Non-ACTED outcomes need no verification. For ACTED turns touching files,
    a clean `git status` in the working directory contradicts the claim, so
    the turn is reported UNVERIFIED for owner follow-up instead of done.
    """
    first = (answer.strip().splitlines() or [""])[0].upper()
    if not first.startswith("ACTED"):
        return ""
    if not directory:
        return "VERIFY: no project directory mapped; outcome taken on trust."
    try:
        r = subprocess.run(
            ["git", "-C", directory, "status", "--porcelain"],
            capture_output=True, text=True, timeout=20,
        )
        changed = [ln for ln in r.stdout.splitlines() if ln.strip()]
        if r.returncode == 0 and changed:
            return f"VERIFY: tree shows {len(changed)} changed file(s); claim consistent."
        return "VERIFY: tree clean; ACTED claim UNVERIFIED, owner confirm needed."
    except Exception as exc:
        return f"VERIFY: check failed ({type(exc).__name__}); outcome taken on trust."


def route_agent0_turn(settings: Settings, channel: str, thread_ts: str | None, message: str,
                      action: bool = False) -> None:
    try:
        directory = project_directory(channel)
        answer = agent0_reply(message, action=action, channel=channel)
        if action:
            answer = relabel_unproven_acted(directory, answer)
        check = verify_action(directory, answer) if action else ""
        reply = answer + ("\n" + check if check else "")
        if action:
            reply += "\n" + audit_line(message, answer)
        AUDIO_JOBS.put((settings, channel, thread_ts, reply, answer, "agent0", True))
    except Exception as exc:
        LOG.exception("Agent0 reasoning handoff failed")
        blocker = f"BLOCKED: Agent0 reasoning handoff failed ({type(exc).__name__}). Nothing was acted on. End turn."
        reply = blocker + "\n" + audit_line(message, blocker)
        AUDIO_JOBS.put((settings, channel, thread_ts, reply, blocker, "agent0", True))


def handle_event(settings: Settings, payload: dict[str, Any]) -> None:
    global VOICE_TARGET
    event = payload.get("event", {})
    if event.get("type") != "app_mention":
        return
    if event.get("bot_id") or event.get("user") == settings.bot_user_id:
        return

    channel = event.get("channel")
    if channel not in settings.allowed_channels:
        LOG.info("Ignoring mention in non-allowed channel %s", channel)
        return

    event_id = payload.get("event_id") or event.get("client_msg_id") or event.get("ts", "")
    if not claim_event(event_id):
        LOG.info("Ignoring duplicate Slack event %s", event_id)
        return

    text = clean_mention_text(event.get("text", ""), settings.bot_user_id)
    LOG.info("Handled app mention in %s with command=%r", channel, text)
    lower = text.lower().strip()
    thread_ts = event.get("thread_ts") or event.get("ts")
    if lower == CONFIRM_CODE:
        confirm_pending_action(settings, channel, thread_ts, event.get("user"))
        return
    if lower.startswith("ask "):
        thread_ts = event.get("thread_ts") or event.get("ts")
        reply, spoken = ask_consultants(settings, channel, thread_ts, text[4:].strip())
        if spoken:
            AUDIO_JOBS.put((settings, channel, thread_ts, reply, spoken, "agent0"))
        else:
            post_message(settings, channel, reply, thread_ts=thread_ts)
        return
    if lower in {"voice pause", "mic off"}:
        VOICE_PAUSED.set()
        post_message(settings, channel, "Microphone standby paused.", thread_ts=event.get("ts"))
        return
    if lower.startswith(("listen", "hear")) or lower in {"voice resume", "mic on"}:
        VOICE_TARGET = (channel, event.get("ts"))
        VOICE_PAUSED.clear()
        post_message(settings, channel, "Ready for break in. Wait for the beep, then speak and finish with end turn.", thread_ts=event.get("ts"))
        return
    if lower in {"demo license", "demo authorize"}:
        queue_demo_license(settings, channel, thread_ts)
        return
    if lower in {"demo standup", "demo stand-up"}:
        queue_demo_standup(settings, channel, thread_ts)
        return
    if not is_builtin_command(text):
        thread_ts = event.get("thread_ts") or event.get("ts")
        explicit_act = lower.startswith("act:")
        # Meeting mode: the owner's @mentions are work orders, not chat.
        # AGENT0_MEETING_MODE=action enables it; anything else keeps the old
        # explicit act: prefix. Bots and non-owners can never trigger action.
        meeting_action = (
            os.environ.get("AGENT0_MEETING_MODE", "gated").lower() == "action"
            and event.get("user") == OWNER_USER_ID
        )
        action_requested = explicit_act or meeting_action
        if action_requested and event.get("user") != OWNER_USER_ID:
            answer = "NEEDS-OWNER: Only Kevin can authorize an Agent0 action. Nothing was acted on. End turn."
            AUDIO_JOBS.put((settings, channel, thread_ts, answer, answer, "agent0"))
            return
        instruction = text[4:].strip() if explicit_act else text
        if action_requested:
            request_action_confirmation(settings, channel, thread_ts, instruction, True)
            return
        post_message(settings, channel, "Agent0 received the turn and is thinking. Status: discussion-only.", thread_ts=thread_ts)
        threading.Thread(
            target=route_agent0_turn,
            args=(settings, channel, thread_ts, instruction, False),
            name="agent0-reasoning",
            daemon=True,
        ).start()
        return
    reply, spoken, voice = response_for(text)
    if spoken:
        AUDIO_JOBS.put((settings, channel, event.get("ts"), reply, spoken, voice))
    else:
        deliver_response(settings, channel, event.get("ts"), reply, spoken, voice)


def acknowledge(ws: websocket.WebSocket, envelope_id: str | None) -> None:
    if envelope_id:
        ws.send(json.dumps({"envelope_id": envelope_id}))


def open_socket(settings: Settings) -> str:
    result = slack_api("apps.connections.open", settings.app_token, post=True)
    if not result.get("ok"):
        raise RuntimeError(f"apps.connections.open failed: {result.get('error')}")
    return result["url"]


CLAUDE_USER_ID = os.environ.get("CLAUDE_USER_ID", "U0C4BBDGA1F")
CHATGPT_USER_ID = os.environ.get("CHATGPT_USER_ID", "U0C3H3GKFB6")
CONSULT_USERS = {
    CLAUDE_USER_ID: "Claude",
    CHATGPT_USER_ID: "ChatGPT",
}
CONSULT_WATCH_FILE = STATE_DIR / "consult-watch.json"
DEMO_STANDUP_LINES = [
    (
        "agent0",
        "Agent zero. Good morning. Yesterday we merged M ten follow model broadcast and closed the milestone. "
        "The web now merges local followed porches and labels every entry by origin. Today we are proving "
        "the voice bridge with Claude Code and three distinct agent voices.",
    ),
    (
        "claude",
        "Claude. On the code side, the important property is fail closed isolation. Every porch is verified "
        "independently, so a tampered package is skipped without breaking the merge. Sealed posts stay sealed, "
        "and no unsigned timeline data reaches display.",
    ),
    (
        "codex",
        "Agent G P T. Product view: this is portable audience infrastructure, not a recommendation feed. "
        "People follow porches they already choose. There is no stranger discovery and no engagement ranking.",
    ),
    (
        "agent0",
        "Agent zero. No open pull requests and no merge blocker. Owner actions now pause for a five minute confirmation code before tools run. Decision needed from Kevin: should the next milestone prioritize remote porch fetching, or finish and harden the live voice demo first? End stand-up.",
    ),
]


def owner_user_token() -> str:
    return os.environ.get("SLACK_USER_TOKEN", "").strip()


def post_as_owner(channel: str, text: str, thread_ts: str | None = None) -> dict[str, Any]:
    token = owner_user_token()
    if not token:
        return {"ok": False, "error": "no_user_token"}
    payload: dict[str, Any] = {"channel": channel, "text": text}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    return slack_api("chat.postMessage", token, payload)


def ask_consultants(settings: Settings, channel: str, thread_ts: str | None,
                    rest: str) -> tuple[str, str | None]:
    """Ping Claude/ChatGPT as the owner so their Slack apps actually wake.

    Those apps ignore bot_id messages. A user-token post looks like Kevin.
    """
    lower = rest.lower().strip()
    who = "both"
    question = rest.strip()
    for prefix in ("both ", "claude ", "chatgpt ", "agentgpt "):
        if lower.startswith(prefix):
            who = prefix.strip()
            question = rest[len(prefix):].strip()
            break
    if not question:
        return "Send `ask claude <question>`, `ask chatgpt <question>`, or `ask both <question>`.", None
    if who == "agentgpt":
        who = "chatgpt"
    if not owner_user_token():
        return (
            "NEEDS-OWNER: Claude and ChatGPT ignore bot mentions. Add SLACK_USER_TOKEN "
            "(your Slack user OAuth token, xoxp-) to ~/.config/agent0-slack/env, then restart "
            "agent0-slack-listener. Nothing was pinged.",
            None,
        )
    targets: list[tuple[str, str]] = []
    if who in {"claude", "both"}:
        targets.append(("Claude", CLAUDE_USER_ID))
    if who in {"chatgpt", "both"}:
        targets.append(("ChatGPT", CHATGPT_USER_ID))
    asked: list[str] = []
    failed: list[str] = []
    for name, uid in targets:
        result = post_as_owner(channel, f"<@{uid}> {question}", thread_ts)
        if result.get("ok"):
            asked.append(name)
        else:
            failed.append(f"{name}:{result.get('error')}")
    if asked and not failed:
        spoken = "Asked " + " and ".join(asked) + " as you."
        return spoken, spoken
    if asked:
        reply = f"Asked {', '.join(asked)}. Failed: {', '.join(failed)}."
        return reply, "Partial consult send."
    return f"Ask failed: {', '.join(failed)}.", None


def _consult_history(token: str, channel: str) -> list[dict[str, Any]]:
    url = f"https://slack.com/api/conversations.history?channel={channel}&limit=5"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    if not data.get("ok"):
        return []
    messages = sorted(data.get("messages", []), key=lambda m: float(m.get("ts", 0) or 0))
    candidates: list[dict[str, Any]] = []
    for parent in messages:
        parent = dict(parent)
        parent["_channel"] = channel
        candidates.append(parent)
        if parent.get("reply_count"):
            try:
                turl = (
                    "https://slack.com/api/conversations.replies"
                    f"?channel={channel}&ts={parent.get('ts')}&limit=15"
                )
                treq = urllib.request.Request(turl, headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(treq, timeout=30) as tresponse:
                    tdata = json.load(tresponse)
                if tdata.get("ok"):
                    for child in tdata.get("messages", []):
                        child = dict(child)
                        child["_channel"] = channel
                        candidates.append(child)
            except Exception as exc:
                LOG.warning("Consultant watcher thread fetch failed: %s", exc)
    return candidates


def consultant_watcher(settings: Settings) -> None:
    """Follow Claude/ChatGPT posts without a human relay.

    Their Slack apps ignore bot mentions. Once a human (or user-token) ping
    wakes them, this poller closes the return leg on lab + standup.
    Loop-safe: only CONSULT_USERS trigger, never our own posts, and
    auto-replies never @mention them.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        marks = json.loads(CONSULT_WATCH_FILE.read_text(encoding="utf-8"))
        watermarks = {str(k): float(v) for k, v in marks.items()}
    except (OSError, ValueError, json.JSONDecodeError):
        watermarks = {}
        legacy = STATE_DIR / "claude-watch-ts"
        try:
            watermarks[settings.lab_channel] = float(legacy.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            pass
    initialized = {ch: watermarks.get(ch, 0) > 0 for ch in settings.allowed_channels}
    while not STOP:
        try:
            time.sleep(25)
            if STOP:
                break
            for channel in sorted(settings.allowed_channels):
                candidates = _consult_history(settings.bot_token, channel)
                candidates.sort(key=lambda m: float(m.get("ts", 0) or 0))
                last_ts = watermarks.get(channel, 0.0)
                if not initialized.get(channel):
                    if candidates:
                        try:
                            last_ts = float(candidates[-1].get("ts", 0) or 0)
                        except ValueError:
                            pass
                        watermarks[channel] = last_ts
                        CONSULT_WATCH_FILE.write_text(json.dumps(watermarks) + "\n", encoding="utf-8")
                    initialized[channel] = True
                    continue
                for message in candidates:
                    ts = message.get("ts", "")
                    try:
                        fts = float(ts)
                    except ValueError:
                        continue
                    if fts <= last_ts:
                        continue
                    last_ts = fts
                    watermarks[channel] = last_ts
                    CONSULT_WATCH_FILE.write_text(json.dumps(watermarks) + "\n", encoding="utf-8")
                    uid = message.get("user")
                    name = CONSULT_USERS.get(uid or "")
                    if not name:
                        continue
                    if not claim_event(f"consult:{uid}:{ts}"):
                        continue
                    text = (message.get("text") or "").strip()[:1500]
                    if not text:
                        continue
                    substance = "\n".join(
                        ln for ln in text.splitlines()
                        if "claude.com/product/tag" not in ln
                        and "Using the legacy Claude in Slack bot" not in ln
                    ).strip()
                    if name == "Claude" and len(substance) < 50:
                        LOG.info("Consultant follow: skipping notice-only %s post %s", name, ts)
                        continue
                    if not substance:
                        continue
                    wants_agent0 = bool(re.search(r"\bagent\s*0\b|\bagentzero\b", substance, flags=re.IGNORECASE))
                    wants_work = bool(re.search(
                        r"\breport\b|\breview\b|\bopen\b|\bpr\b|\bcheck\b|\blook\b|\bfix\b"
                        r"|\bmake\b|\bdraft\b|\blist\b|\bsummar",
                        substance, flags=re.IGNORECASE))
                    is_order = wants_agent0 and wants_work
                    LOG.info("Consultant follow: %s post %s, routing %s turn", name, ts, "ACTION" if is_order else "discussion")
                    voice = "claude" if name == "Claude" else "codex"
                    AUDIO_JOBS.put((settings, channel, ts, "", f"{name}. {substance}", voice))
                    route_agent0_turn(
                        settings, channel, ts,
                        f"{name} posted (auto-follow, no human mention needed): {substance}",
                        is_order,
                    )
        except Exception as exc:
            LOG.warning("Consultant watcher failed: %s", exc)


def run(settings: Settings) -> None:
    backoff = 2
    while not STOP:
        try:
            url = open_socket(settings)
            LOG.info("Socket Mode connection opened; allowed_channels=%s", sorted(settings.allowed_channels))
            ws = websocket.create_connection(url, timeout=60)
            backoff = 2
            while not STOP:
                raw = ws.recv()
                if not raw:
                    continue
                message = json.loads(raw)
                envelope_id = message.get("envelope_id")
                acknowledge(ws, envelope_id)
                if message.get("type") == "events_api":
                    handle_event(settings, message.get("payload", {}))
        except KeyboardInterrupt:
            break
        except Exception as exc:
            LOG.warning("Listener loop failed: %s", exc)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


def _stop(_signum: int, _frame: Any) -> None:
    global STOP
    STOP = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Agent0 Slack Socket Mode listener")
    parser.add_argument("--env", default="/home/kevin/.config/agent0-slack/env")
    parser.add_argument("--check", action="store_true", help="Validate Slack credentials and exit.")
    args = parser.parse_args()

    logging.basicConfig(level=os.environ.get("AGENT0_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    settings = build_settings(args.env)
    load_seen_events()
    # Mic defaults PAUSED: listening opens only on explicit `listen`/`mic on`
    # (meeting window), never at startup. Transcribing room audio 24/7 burned
    # ~47% CPU and no meeting was ever announced by default-listening.
    VOICE_PAUSED.set()
    if args.check:
        connection = slack_api("apps.connections.open", settings.app_token, post=True)
        print(
            json.dumps(
                {
                    "ok": bool(connection.get("ok")),
                    "error": connection.get("error"),
                    "has_socket_url": bool(connection.get("url")),
                    "bot_user_id": settings.bot_user_id,
                    "allowed_channels": sorted(settings.allowed_channels),
                },
                sort_keys=True,
            )
        )
        return 0 if connection.get("ok") else 1

    threading.Thread(target=audio_worker, args=(settings,), name="agent0-audio", daemon=True).start()
    threading.Thread(target=consultant_watcher, args=(settings,), name="agent0-consult-watch", daemon=True).start()
    run(settings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
