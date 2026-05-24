// Facade — exports `db.<table>(ctx)` factories.
// Filled in as each repo is added (Tasks 3-5).

import { tasksRepo } from './tasks.ts';
import { projectsRepo } from './projects.ts';
import { agentsRepo } from './agents.ts';
import { connectorsRepo } from './connectors.ts';
import { commentsRepo } from './comments.ts';
import { externalRefsRepo } from './external-refs.ts';
import { eventsRepo } from './events.ts';

export const db = {
  // pool repos (Tasks 3-4)
  tasks: tasksRepo,
  projects: projectsRepo,
  agents: agentsRepo,
  connectors: connectorsRepo,
  comments: commentsRepo,
  externalRefs: externalRefsRepo,
  events: eventsRepo,
};

export type DB = typeof db;
