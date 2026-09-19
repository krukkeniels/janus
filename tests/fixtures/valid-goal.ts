export const validGoal = {
  id: 'angular-15-to-16',
  source_version: '15',
  target_version: '16',
  title: 'Upgrade Angular 15 to 16',
  repos: [
    {
      name: 'ui-kit',
      kind: 'library',
      scm: { project: 'FE', slug: 'ui-kit' },
      base_branch: 'main',
      package_name: '@acme/ui-kit',
      ci: { pr_build_type_id: 'Fe_UiKit_Build', publish_build_type_id: 'Fe_UiKit_Publish' },
    },
    {
      name: 'shell',
      kind: 'shell',
      scm: { project: 'FE', slug: 'shell' },
      base_branch: 'main',
      ci: { pr_build_type_id: 'Fe_Shell_Build' },
      depends_on: ['ui-kit'],
      loads_remotes: ['orders-remote'],
    },
    {
      name: 'orders-remote',
      kind: 'remote',
      scm: { project: 'FE', slug: 'orders-remote' },
      base_branch: 'develop',
      ci: { pr_build_type_id: 'Fe_Orders_Build' },
      depends_on: ['ui-kit'],
      coupled_with: ['shell'],
    },
  ],
  e2e: {
    build_type_id: 'Fe_E2E_Full',
    branch_params: { shell: 'env.SHELL_BRANCH', 'orders-remote': 'env.ORDERS_BRANCH' },
  },
};
