# IELTS LMS frontend

See the [root README](../README.md) for installation and monorepo commands.

`src/app` contains providers and routing, `src/components/ui` contains shadcn/ui,
and `src/features` is reserved for future business features.
The API client reads `VITE_API_URL`, defaulting to `http://localhost:3000/api`.
Never put Neon credentials in frontend environment variables.
