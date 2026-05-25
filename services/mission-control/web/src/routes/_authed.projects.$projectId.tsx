import { createFileRoute } from '@tanstack/react-router';
import { ProjectDetail } from '@/components/projects/project-detail';

export const Route = createFileRoute('/_authed/projects/$projectId')({
  component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
  const { projectId } = Route.useParams();
  return <ProjectDetail projectId={projectId} />;
}
