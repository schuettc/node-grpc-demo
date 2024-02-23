const { awscdk } = require('projen');
const { JobPermission } = require('projen/lib/github/workflows-model');
const { UpgradeDependenciesSchedule } = require('projen/lib/javascript');
const AUTOMATION_TOKEN = 'PROJEN_GITHUB_TOKEN';

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.126.0',
  defaultReleaseBranch: 'main',
  name: 'node-grpc-demo',
  appEntrypoint: 'node-grpc-demo.ts',
  license: 'MIT-0',
  author: 'Court Schuett',
  copyrightOwner: 'Court Schuett',
  authorAddress: 'https://subaud.io',
  devDeps: ['esbuild'],
  projenrcTs: true,
  jest: false,
  deps: [
    '@aws-sdk/client-cloudfront',
    '@aws-sdk/client-s3',
    '@types/aws-lambda',
    'aws-lambda',
    'dotenv',
  ],
  autoApproveOptions: {
    secret: 'GITHUB_TOKEN',
    allowedUsernames: ['schuettc'],
  },
  depsUpgradeOptions: {
    ignoreProjen: false,
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
  },
});

project.addTask('launch', {
  exec: 'yarn && yarn projen && yarn build && yarn cdk bootstrap && yarn cdk deploy  --require-approval never && yarn writeDistributionDomain',
});

project.addTask('getDistributionDomain', {
  exec: "aws cloudformation describe-stacks --stack-name gRPCServer --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`target`].OutputValue' --output text",
});

project.addTask('writeDistributionDomain', {
  exec: 'echo TARGET=$(yarn run --silent getDistributionDomain) > ./client/src/.env',
});

project.tsconfigDev.file.addOverride('include', [
  'src/**/*.ts',
  'client/**/*.ts',
  './.projenrc.ts',
]);

project.eslint.addOverride({
  files: ['src/resources/**/*.ts'],
  rules: {
    'indent': 'off',
    '@typescript-eslint/indent': 'off',
  },
});

project.eslint.addOverride({
  files: ['src/resources/**/*.ts', 'client/src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-require-imports': 'off',
    'import/no-extraneous-dependencies': 'off',
  },
});

const common_exclude = [
  'cdk.out',
  '*.wav',
  'yarn-error.log',
  'dependabot.yml',
  '.DS_Store',
  '**/dist/**',
  '.env',
];

project.gitignore.exclude(...common_exclude);
project.synth();
