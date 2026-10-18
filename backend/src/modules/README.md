# Business modules

Create each feature as a NestJS module, for example `students/students.module.ts`,
`students.controller.ts`, `students.service.ts` and `dto/` when needed.
Import its module in `app.module.ts`. Import `DatabaseModule` wherever SQL access
is needed. `health/` contains the existing service and database health endpoints.
