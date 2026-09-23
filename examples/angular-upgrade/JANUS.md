# Goal
Upgrade every Angular application in this folder from Angular 15 to Angular 16.

Each application is a Git clone in a sub-folder of this folder. The package manager is pnpm.
Google Chrome is installed at `/usr/bin/google-chrome`, so the unit tests run headless.

A task is done when, in its own repository folder:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@16 @angular/cli@16` has been run and every migration it offers
  has been applied;
- `package.json` asks for Angular 16 and no `@angular/*` dependency is left at 15;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds with no test skipped or removed;
- the work is committed on the branch `ai/angular-15-to-16`.

Do not upgrade past 16, do not change unrelated dependencies and do not reformat files the
upgrade does not touch.
