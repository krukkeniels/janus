# Goal
Upgrade every Angular application in this folder one major at a time. Each step names its target
major and its branch; `flow.py` walks the majors in `MAJORS`, one full pass per major.

Each application is a Git clone in a sub-folder of this folder. The package manager is pnpm.
Google Chrome is installed at `/usr/bin/google-chrome`, so the unit tests run headless.

A task is done when, in its own repository folder, with `<target>` the major the step names:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@<target> @angular/cli@<target>` has been run and every migration
  it offers has been applied;
- `package.json` asks for Angular `<target>` and no `@angular/*` dependency is left at the
  previous major;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds with no test skipped or removed;
- the work is committed on the branch the step names.

Do not upgrade past the target major, do not change unrelated dependencies and do not reformat
files the upgrade does not touch.
