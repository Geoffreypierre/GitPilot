# GitPilot

Dashboard Electron pour centraliser plusieurs dépôts Git locaux : consultation des branches et exécution d'actions (scripts) personnalisées par projet. Interface inspirée de GitLab en mode sombre.

## Démarrage

```bash
npm install
npm start
```

Prérequis : Git installé et accessible dans le `PATH`. Sous Windows, Git Bash (fourni avec Git for Windows) est utilisé par défaut pour les actions ; cmd.exe et PowerShell sont aussi disponibles.

## Structure

```
main.js                 Processus principal : fenêtre, IPC
src/main/store.js       Persistance JSON (userData/gitpilot-data.json), validation
src/main/git.js         Validation des dépôts, git fetch, lecture des branches
src/main/runner.js      Exécution des actions (processus isolé, streaming, timeout, annulation)
src/preload/preload.js  API exposée au renderer (contextBridge)
src/renderer/           Interface (HTML/CSS/JS, sans étape de build)
```

## Sécurité

- Renderer sandboxé (`contextIsolation`, `sandbox`, pas de `nodeIntegration`, CSP stricte, navigation bloquée).
- Le renderer n'envoie que des identifiants : le script exécuté est toujours celui enregistré, dans le dossier du projet concerné.
- Git est appelé via `execFile` avec des arguments (aucun shell, aucune interpolation).
- Les scripts n'ont pas d'entrée standard, ont un délai maximal configurable et peuvent être arrêtés (arbre de processus complet).

## Variables utiles

- `GITPILOT_DATA_DIR` : dossier de données alternatif (tests, utilisation portable).
- Si `ELECTRON_RUN_AS_NODE` est défini dans votre environnement, Electron démarre comme Node : supprimez cette variable avant `npm start`.
