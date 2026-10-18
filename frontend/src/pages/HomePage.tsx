import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
function ServiceStatus({
  title,
  endpoint,
}: {
  title: string;
  endpoint: string;
}) {
  const query = useQuery({
    queryKey: ['health', endpoint],
    queryFn: async () => (await api.get(endpoint)).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4" aria-live="polite">
        <p>
          {query.isPending
            ? 'Checking connection…'
            : query.isError
              ? 'Unavailable. Check the service configuration and try again.'
              : 'Connected'}
        </p>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </CardContent>
    </Card>
  );
}
export function HomePage() {
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          Clover · IELTS LMS
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Development status
        </h1>
        <p className="text-muted-foreground">
          The foundation for your IELTS learning platform.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Frontend</CardTitle>
            <CardDescription>React application</CardDescription>
          </CardHeader>
          <CardContent>Running</CardContent>
        </Card>
        <ServiceStatus title="Backend API" endpoint="/health" />
        <ServiceStatus title="Database" endpoint="/health/database" />
      </div>
    </main>
  );
}
