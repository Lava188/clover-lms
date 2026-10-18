import { Link } from 'react-router';
export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-16">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <Link to="/" className="underline">
        Return home
      </Link>
    </main>
  );
}
