# SQL migrations

Use numbered, descriptive filenames such as `001_bootstrap_users.sql` and
`002_create_classes.sql`. Review SQL in a pull request before applying it.

These files are executed manually in Neon SQL Editor on a confirmed development
branch. There is no automatic migration runner or version tracking yet; record
which files have been applied to each branch. Do not rerun applied files or edit
migrations already used by the team. Inspect existing tables before applying the
bootstrap file. Nothing here runs on application startup.
