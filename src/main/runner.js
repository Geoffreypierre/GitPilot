'use strict';

const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const MAX_LINES = 5000;
const MAX_LINE_LENGTH = 4000;
const MAX_RUNS_PER_PROJECT = 30;
const PARTIAL_FLUSH_MS = 300;
const EMIT_BATCH_MS = 40;
const TRACE_MARK = '\x1e';
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/* ---------- Résolution des shells ---------- */

let bashPathCache;
function findBash() {
  if (bashPathCache !== undefined) return bashPathCache;
  const candidates = [];
  if (IS_WIN) {
    const bases = [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    ].filter(Boolean);
    for (const base of bases) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
    try {
      const out = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const dir = path.dirname(line);
        candidates.push(path.resolve(dir, '..', 'bin', 'bash.exe'));
        candidates.push(path.resolve(dir, '..', '..', 'bin', 'bash.exe'));
      }
    } catch { /* git absent du PATH */ }
  } else {
    candidates.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash');
  }
  bashPathCache = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return bashPathCache;
}

function availableShells() {
  return [
    { id: 'system', label: IS_WIN ? 'Invite de commandes (cmd.exe)' : 'sh (/bin/sh)', available: true },
    { id: 'powershell', label: IS_WIN ? 'Windows PowerShell' : 'PowerShell (pwsh)', available: true },
    { id: 'bash', label: IS_WIN ? 'Git Bash' : 'Bash', available: Boolean(findBash()), path: findBash() },
  ];
}

function shellLabel(id) {
  return availableShells().find((s) => s.id === id)?.label || id;
}

/** Windows + Git Bash : arrête tout le groupe de processus MSYS du script. */
function killMsysGroup(pidFile) {
  const bash = findBash();
  if (!bash || !pidFile) return;
  let msysPid;
  try { msysPid = fs.readFileSync(pidFile, 'utf8').trim(); } catch { return; }
  if (!/^\d+$/.test(msysPid)) return;
  const killExe = [
    path.join(path.dirname(bash), 'kill.exe'),
    path.resolve(path.dirname(bash), '..', 'usr', 'bin', 'kill.exe'),
  ].find((p) => fs.existsSync(p));
  if (!killExe) return;
  spawn(killExe, ['-s', 'KILL', '--', `-${msysPid}`], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
}

function scriptsDir() {
  const dir = path.join(os.tmpdir(), 'gitpilot-runs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Écrit le script dans un fichier temporaire propre à l'exécution puis construit
 * la commande. Passer par un fichier permet les scripts multi-lignes sans
 * aucune interpolation de la part de l'application.
 */
function prepareCommand(shellId, script, runId, { bashTrace }) {
  const base = path.join(scriptsDir(), runId);
  const write = (file, content) => {
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o700 });
    return file;
  };

  switch (shellId) {
    case 'system': {
      if (IS_WIN) {
        const body = `@echo off\r\nchcp 65001 >nul\r\n${script.replace(/\r?\n/g, '\r\n')}\r\n`;
        const file = write(`${base}.cmd`, body);
        return { file, command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', file] };
      }
      const file = write(`${base}.sh`, `${script}\n`);
      return { file, command: '/bin/sh', args: [file] };
    }
    case 'powershell': {
      const prelude = [
        "$ProgressPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '',
      ].join('\r\n');
      const epilogue = '\r\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n';
      // BOM indispensable pour que Windows PowerShell 5.1 lise correctement l'UTF-8.
      const file = write(`${base}.ps1`, `﻿${prelude}${script.replace(/\r?\n/g, '\r\n')}${epilogue}`);
      return {
        file,
        command: IS_WIN ? 'powershell.exe' : 'pwsh',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      };
    }
    case 'bash': {
      const bash = findBash();
      if (!bash) {
        throw new Error(IS_WIN
          ? 'Git Bash est introuvable. Installez Git for Windows ou choisissez un autre shell.'
          : 'Bash est introuvable sur ce système.');
      }
      const toPosix = (p) => (IS_WIN ? p.replace(/\\/g, '/') : p);
      const pidFile = `${base}.pid`;
      // Le PID MSYS permet d'arrêter tout le groupe de processus (taskkill ne voit
      // pas les enfants créés par l'émulation fork de MSYS).
      let prelude = `printf '%s' "$$" > '${toPosix(pidFile)}'\n`;
      // La trace passe par stdout pour rester dans l'ordre de la sortie standard.
      if (bashTrace) prelude += `exec 19>&1\nBASH_XTRACEFD=19\nPS4=$'${TRACE_MARK} '\nset -x\n`;
      const file = write(`${base}.sh`, `${prelude}${script}\n`);
      return { file, pidFile, command: bash, args: [toPosix(file)] };
    }
    default:
      throw new Error(`Shell inconnu : ${shellId}`);
  }
}

/* ---------- Gestionnaire d'exécutions ---------- */

class Runner extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map();
    this.pending = new Map();
    this.emitTimer = null;
  }

  summary(run) {
    return {
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      actionId: run.actionId,
      actionName: run.actionName,
      shell: run.shell,
      cwd: run.cwd,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      truncated: run.truncated,
    };
  }

  list(projectId) {
    return [...this.runs.values()]
      .filter((r) => !projectId || r.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => this.summary(r));
  }

  get(runId) {
    const run = this.runs.get(runId);
    if (!run) throw Object.assign(new Error('Exécution introuvable.'), { userMessage: 'Exécution introuvable.' });
    return { ...this.summary(run), lines: run.lines };
  }

  isRunning(projectId, actionId) {
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.projectId === projectId && run.actionId === actionId) return true;
    }
    return false;
  }

  start({ project, action, shellId, timeoutMs, bashTrace }) {
    const run = {
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      actionId: action.id,
      actionName: action.name,
      shell: shellId,
      cwd: project.path,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      truncated: false,
      lines: [],
      child: null,
      file: null,
      buffers: { stdout: '', stderr: '' },
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      partialTimers: {},
      cancelled: false,
      timedOut: false,
    };
    this.runs.set(run.id, run);
    this.prune(project.id);

    this.emit('status', this.summary(run));
    this.push(run, 'info', `Exécution de '${action.name}' dans ${project.path}`);
    this.push(run, 'info', `Shell : ${shellLabel(shellId)}`);

    let prepared;
    try {
      prepared = prepareCommand(shellId, action.script, run.id, { bashTrace });
      run.file = prepared.file;
      run.pidFile = prepared.pidFile || null;
    } catch (err) {
      this.push(run, 'stderr', err.message);
      this.finish(run, 'error', null);
      return this.summary(run);
    }

    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GITPILOT_PROJECT_NAME: project.name,
      GITPILOT_PROJECT_PATH: project.path,
      GITPILOT_ACTION_NAME: action.name,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: project.path,
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // pas d'entrée interactive : un script ne peut pas rester bloqué sur une saisie
        windowsHide: true,
        detached: !IS_WIN,
      });
    } catch (err) {
      this.push(run, 'stderr', `Impossible de lancer le shell : ${err.message}`);
      this.finish(run, 'error', null);
      return this.summary(run);
    }
    run.child = child;

    child.stdout.on('data', (chunk) => this.onData(run, 'stdout', chunk));
    child.stderr.on('data', (chunk) => this.onData(run, 'stderr', chunk));
    child.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `Shell introuvable : ${prepared.command}`
        : `Erreur d'exécution : ${err.message}`;
      this.push(run, 'stderr', msg);
      this.finish(run, 'error', null);
    });
    const onEnd = (code, signal) => {
      if (run.status !== 'running') return;
      this.flushPartial(run, 'stdout', true);
      this.flushPartial(run, 'stderr', true);
      let status = code === 0 ? 'success' : 'error';
      if (run.cancelled) status = 'cancelled';
      else if (run.timedOut) {
        this.push(run, 'stderr', `Délai d'exécution dépassé (${Math.max(1, Math.round(timeoutMs / 60000))} min) : processus arrêté.`);
        status = 'error';
      }
      this.finish(run, status, code ?? (signal ? -1 : null));
    };
    child.on('close', onEnd);
    child.on('exit', (code, signal) => {
      // Si un processus lancé en arrière-plan garde la sortie ouverte, on clôt
      // quand même l'exécution une fois le shell terminé.
      setTimeout(() => {
        if (run.status !== 'running') return;
        child.stdout.destroy();
        child.stderr.destroy();
        this.push(run, 'info', 'Le shell est terminé ; des processus lancés en arrière-plan par le script peuvent encore être actifs.');
        onEnd(code, signal);
      }, 2000);
    });

    run.timeout = setTimeout(() => {
      if (run.status !== 'running') return;
      run.timedOut = true;
      this.kill(run);
    }, timeoutMs);

    return this.summary(run);
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return false;
    run.cancelled = true;
    this.push(run, 'info', "Arrêt demandé par l'utilisateur…");
    this.kill(run);
    return true;
  }

  cancelProject(projectId) {
    for (const run of this.runs.values()) {
      if (run.projectId === projectId && run.status === 'running') this.cancel(run.id);
    }
  }

  killAll() {
    for (const run of this.runs.values()) {
      if (run.status === 'running') this.kill(run);
    }
  }

  kill(run) {
    const pid = run.child?.pid;
    if (!pid) return;
    if (IS_WIN) {
      if (run.shell === 'bash') killMsysGroup(run.pidFile);
      // Termine l'arbre de processus complet (le shell et tout ce qu'il a lancé).
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* déjà terminé */ }
      setTimeout(() => {
        if (run.status === 'running') { try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ } }
      }, 3000);
    }
  }

  onData(run, stream, chunk) {
    run.buffers[stream] += run.decoders[stream].write(chunk);
    const parts = run.buffers[stream].split('\n');
    run.buffers[stream] = parts.pop();
    for (const line of parts) this.push(run, stream, line);

    if (run.buffers[stream].length > MAX_LINE_LENGTH) this.flushPartial(run, stream, true);
    clearTimeout(run.partialTimers[stream]);
    if (run.buffers[stream]) {
      run.partialTimers[stream] = setTimeout(() => this.flushPartial(run, stream, false), PARTIAL_FLUSH_MS);
    }
  }

  flushPartial(run, stream, final) {
    clearTimeout(run.partialTimers[stream]);
    if (final) run.buffers[stream] += run.decoders[stream].end();
    if (run.buffers[stream]) {
      this.push(run, stream, run.buffers[stream]);
      run.buffers[stream] = '';
    }
  }

  push(run, type, rawText) {
    let text = String(rawText).replace(ANSI_RE, '');
    // Les barres de progression réécrivent la ligne avec \r : on ne garde que le dernier état.
    if (text.includes('\r')) {
      const segments = text.split('\r').filter((s) => s.length);
      text = segments.length ? segments[segments.length - 1] : '';
    }
    if ((type === 'stdout' || type === 'stderr') && text.startsWith(TRACE_MARK)) {
      type = 'cmd';
      text = text.replace(new RegExp(`^${TRACE_MARK}+\\s?`), '');
    }
    if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}…`;

    const entry = { t: Date.now(), type, text };
    run.lines.push(entry);
    if (run.lines.length > MAX_LINES) {
      run.lines.splice(0, run.lines.length - MAX_LINES);
      run.truncated = true;
    }

    if (!this.pending.has(run.id)) this.pending.set(run.id, []);
    this.pending.get(run.id).push(entry);
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this.flushEmit(), EMIT_BATCH_MS);
  }

  flushEmit() {
    this.emitTimer = null;
    for (const [runId, lines] of this.pending) this.emit('output', { runId, lines });
    this.pending.clear();
  }

  finish(run, status, exitCode) {
    if (run.status !== 'running') return;
    clearTimeout(run.timeout);
    run.status = status;
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    run.child = null;

    const seconds = ((run.endedAt - run.startedAt) / 1000).toFixed(1);
    if (status === 'success') this.push(run, 'success', `Succès ✅ (${seconds} s)`);
    else if (status === 'cancelled') this.push(run, 'error', `Exécution annulée ⏹ (${seconds} s)`);
    else this.push(run, 'error', `Échec ❌${exitCode != null ? ` — code de sortie ${exitCode}` : ''} (${seconds} s)`);

    for (const f of [run.file, run.pidFile]) if (f) fs.rm(f, { force: true }, () => {});
    this.flushEmit();
    this.emit('status', this.summary(run));
  }

  prune(projectId) {
    const runs = [...this.runs.values()]
      .filter((r) => r.projectId === projectId && r.status !== 'running')
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const old of runs.slice(MAX_RUNS_PER_PROJECT)) this.runs.delete(old.id);
  }
}

module.exports = { Runner, availableShells, findBash };
