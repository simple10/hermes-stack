// Facade — exports `db.<table>(ctx)` factories.
// Tasks 3-5: pool repos + master repos.

import { tasksRepo } from './tasks.ts';
import { projectsRepo } from './projects.ts';
import { agentsRepo } from './agents.ts';
import { connectorsRepo } from './connectors.ts';
import { commentsRepo } from './comments.ts';
import { externalRefsRepo } from './external-refs.ts';
import { eventsRepo } from './events.ts';
import { usersRepo } from './users.ts';
import { orgsRepo } from './orgs.ts';
import { membersRepo } from './members.ts';
import { apiKeysRepo } from './api-keys.ts';

export const db = {
  // pool repos (Tasks 3-4)
  tasks: tasksRepo,
  projects: projectsRepo,
  agents: agentsRepo,
  connectors: connectorsRepo,
  comments: commentsRepo,
  externalRefs: externalRefsRepo,
  events: eventsRepo,
  // master repos (Task 5)
  users: usersRepo,
  orgs: orgsRepo,
  members: membersRepo,
  apiKeys: apiKeysRepo,
};

export type DB = typeof db;
