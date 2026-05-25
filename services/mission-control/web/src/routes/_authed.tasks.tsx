import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/tasks')({
  component: TasksRoute,
});

function TasksRoute() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Tasks</h1>
      <p className="text-muted-foreground mt-2">
        (Read-only tasks list — implementation pending Phase 6.)
      </p>
    </div>
  );
}
