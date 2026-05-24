// Facade — exports `db.<table>(ctx)` factories.
// Filled in as each repo is added (Tasks 3-5).

import { tasksRepo } from './tasks.ts';
import { projectsRepo } from './projects.ts';
import { agentsRepo } from './agents.ts';
import { connectorsRepo } from './connectors.ts';

export const db = {
  // pool repos (Tasks 3-4)
  tasks: tasksRepo,
  projects: projectsRepo,
  agents: agentsRepo,
  connectors: connectorsRepo,
};

export type DB = typeof db;
