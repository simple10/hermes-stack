import { createFileRoute } from '@tanstack/react-router';
import { ProjectsTable } from '@/components/projects/projects-table';
import { CreateProjectDialog } from '@/components/projects/create-project-dialog';

export const Route = createFileRoute('/_authed/projects')({
  component: ProjectsRoute,
});

function ProjectsRoute() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Projects</h1>
        <CreateProjectDialog />
      </div>
      <ProjectsTable />
    </div>
  );
}
