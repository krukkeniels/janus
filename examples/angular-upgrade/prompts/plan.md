---
output:
  summary: str
  tasks:
    - id: str
      repo: str
      title: str
      objective: str
      build_type: str
---
Plan the work. This step changes nothing: do not edit, create or delete any file, and do not
create the branch yet.

Every product repository is a sub-folder of the folder you were started in that is a Git
repository. Ignore any sub-folder that is not a Git repository (no `.git` inside), which rules
out `prompts`, `journals`, `tests`, `__pycache__` and any folder whose name starts with a dot.
For each repository, read `package.json`, `angular.json` and enough of the source to see what
the goal needs there.

Produce one task per repository, ordered so that a repository other repositories depend on
comes first. For each task:

- `id`: the repository's sub-folder name, exactly as it is on disk, which must be safe in a file
  path (for example `ui-kit`). Only if one repository needs more than one task, add a short
  lowercase suffix after a dash (`ui-kit-styles`) so that every `id` in this plan is unique.
- `repo`: the sub-folder name of that repository, exactly as it is on disk.
- `title`: one line naming what the task changes.
- `objective`: two to five sentences: where the repository stands now, what to change, and which
  checks from the goal decide that the task is done.
- `build_type`: the TeamCity build type id that builds this repository if the repository names
  one (for example in `.teamcity` or its README), otherwise the string `none`.

`summary` is two or three sentences a human can approve without reading the tasks.
