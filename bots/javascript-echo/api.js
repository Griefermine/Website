// Der Pfad gilt für den kopierten Workspace (bots/<id>/workspace):
//   Host      -> bots/shared/api.js
//   Container -> /shared/api.js (schreibgeschützt eingebunden)
// Aus dem Vorlagenordner selbst ist er nicht auflösbar; der Hub kopiert die
// Vorlage beim Anlegen in den Workspace.
export { botHubApi, createBotHubApi } from '../../shared/api.js';
