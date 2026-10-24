'use strict';

const { EventEmitter } = require('events');

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // limite de setTimeout (~24,8 jours)
// Au démarrage, une programmation en retard de plus de ce délai n'est pas exécutée.
const MISSED_GRACE_MS = 60_000;

/**
 * Exécutions différées (une seule fois, à date fixe). Les programmations sont
 * enregistrées dans le store ; elles ne se déclenchent que si l'application est ouverte.
 * Émet 'changed' à chaque modification de la liste.
 */
class Scheduler extends EventEmitter {
  constructor(store, startAction) {
    super();
    this.store = store;
    this.startAction = startAction;
    this.timers = new Map();
  }

  start() {
    const now = Date.now();
    for (const s of this.store.listSchedules()) {
      if (s.status !== 'pending') continue;
      if (s.runAt < now - MISSED_GRACE_MS) {
        this.store.updateSchedule(s.id, { status: 'missed', error: "L'application était fermée à l'heure prévue." });
      } else {
        this.arm(s);
      }
    }
  }

  arm(schedule) {
    this.disarm(schedule.id);
    const delay = Math.max(0, schedule.runAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      if (schedule.runAt - Date.now() > 1000) this.arm(schedule); // échéance au-delà de la limite de setTimeout
      else this.fire(schedule.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timers.set(schedule.id, timer);
  }

  disarm(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  fire(id) {
    const schedule = this.store.findSchedule(id);
    if (!schedule || schedule.status !== 'pending') return;
    try {
      this.startAction(schedule.projectId, schedule.actionId, schedule);
      this.store.removeSchedule(id);
    } catch (err) {
      this.store.updateSchedule(id, { status: 'failed', error: err.userMessage || err.message });
    }
    this.emit('changed');
  }

  create(projectId, actionId, runAt) {
    const schedule = this.store.createSchedule(projectId, actionId, runAt);
    this.arm(schedule);
    this.emit('changed');
    return schedule;
  }

  /** Annule une programmation en attente, ou retire une programmation manquée / en échec. */
  cancel(id) {
    this.disarm(id);
    this.store.removeSchedule(id);
    this.emit('changed');
    return true;
  }

  /** À appeler après la suppression d'un projet ou d'une action : désarme les minuteries orphelines. */
  prune() {
    const ids = new Set(this.store.listSchedules().map((s) => s.id));
    for (const id of [...this.timers.keys()]) if (!ids.has(id)) this.disarm(id);
    this.emit('changed');
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }
}

module.exports = { Scheduler };
