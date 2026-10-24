'use strict';

/**
 * État partagé du renderer : informations de l'application, projets et suivi
 * des exécutions (alimenté en continu par les événements du processus principal).
 */
const State = (() => {
  const bus = new EventTarget();
  const state = {
    info: null,
    settings: null,
    projects: [],
    runs: new Map(), // runId -> { ...summary, lines?: [] }
    schedules: [],
  };

  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const on = (type, fn) => {
    const listener = (e) => fn(e.detail);
    bus.addEventListener(type, listener);
    return () => bus.removeEventListener(type, listener);
  };

  async function loadProjects() {
    state.projects = await window.gitpilot.projects.list();
    emit('projects', state.projects);
    return state.projects;
  }

  function getProject(id) {
    return state.projects.find((p) => p.id === id) || null;
  }

  function upsertProject(project) {
    const i = state.projects.findIndex((p) => p.id === project.id);
    if (i === -1) state.projects.push(project);
    else state.projects[i] = project;
    emit('projects', state.projects);
  }

  function removeProject(id) {
    state.projects = state.projects.filter((p) => p.id !== id);
    emit('projects', state.projects);
  }

  /* ---------- Exécutions ---------- */

  function trackRun(summary, { live = false } = {}) {
    const existing = state.runs.get(summary.id);
    // Une exécution découverte en direct dès son démarrage reçoit toute sa sortie par événements.
    const base = existing || { lines: [], linesLoaded: live && summary.status === 'running' };
    state.runs.set(summary.id, { ...base, ...summary });

    // Reflète le dernier statut dans l'action côté renderer.
    if (summary.status !== 'running') {
      const action = getProject(summary.projectId)?.actions.find((a) => a.id === summary.actionId);
      if (action) {
        action.lastRun = { status: summary.status, exitCode: summary.exitCode, startedAt: summary.startedAt, endedAt: summary.endedAt };
      }
    }
    emit('run-status', state.runs.get(summary.id));
  }

  async function loadRun(runId) {
    const full = await window.gitpilot.runs.get(runId);
    state.runs.set(runId, { ...(state.runs.get(runId) || {}), ...full, linesLoaded: true });
    return state.runs.get(runId);
  }

  function runsFor(projectId) {
    return [...state.runs.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  function latestRunFor(projectId, actionId) {
    return runsFor(projectId).find((r) => r.actionId === actionId) || null;
  }

  function runningCount() {
    let n = 0;
    for (const r of state.runs.values()) if (r.status === 'running') n += 1;
    return n;
  }

  /* ---------- Programmations ---------- */

  function setSchedules(list) {
    state.schedules = Array.isArray(list) ? list : [];
    emit('schedules', state.schedules);
  }

  async function loadSchedules() {
    setSchedules(await window.gitpilot.schedules.list());
    return state.schedules;
  }

  function schedulesFor(projectId, actionId) {
    return state.schedules
      .filter((s) => s.projectId === projectId && (!actionId || s.actionId === actionId))
      .sort((a, b) => a.runAt - b.runAt);
  }

  window.gitpilot.schedules.onChanged(setSchedules);
  window.gitpilot.runs.onStatus((summary) => trackRun(summary, { live: true }));
  window.gitpilot.runs.onOutput(({ runId, lines }) => {
    const run = state.runs.get(runId);
    if (run) {
      run.lines = run.lines || [];
      run.lines.push(...lines);
      if (run.lines.length > 5000) run.lines.splice(0, run.lines.length - 5000);
    }
    emit('run-output', { runId, lines });
  });

  return {
    get info() { return state.info; },
    set info(v) { state.info = v; },
    get settings() { return state.settings; },
    set settings(v) { state.settings = v; emit('settings', v); },
    get projects() { return state.projects; },
    on,
    emit,
    loadProjects,
    getProject,
    upsertProject,
    removeProject,
    trackRun,
    loadRun,
    runsFor,
    latestRunFor,
    runningCount,
    loadSchedules,
    setSchedules,
    schedulesFor,
    allRuns: () => [...state.runs.values()].sort((a, b) => b.startedAt - a.startedAt),
  };
})();
