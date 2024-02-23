import { StackProps, Stack, CfnOutput, App } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { config } from 'dotenv';
import { ECSResources, VPCResources, CertificateResources } from '.';
export interface NodeGRPCDemoProps extends StackProps {
  logLevel: string;
  domainName: string;
}

config();

export class NodeGRPCDemo extends Stack {
  constructor(scope: Construct, id: string, props: NodeGRPCDemoProps) {
    super(scope, id, props);

    if (!props.domainName) {
      throw new Error('Domain Name is required');
    }

    const vpcResources = new VPCResources(this, 'VPCResources');
    const certificateResources = new CertificateResources(
      this,
      'CertificateResources',
      {
        domainName: props.domainName,
      },
    );

    new ECSResources(this, 'ECSResources', {
      vpc: vpcResources.vpc,
      logLevel: props.logLevel,
      applicationLoadBalancerSecurityGroup:
        vpcResources.applicationLoadBalancerSecurityGroup,
      certificate: certificateResources.certificate,
      hostedZone: certificateResources.hostedZone,
    });

    new CfnOutput(this, 'target', {
      value: `grpc.${props.domainName}`,
    });
  }
}

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

const stackProps = {
  logLevel: process.env.LOG_LEVEL || 'INFO',
  domainName: process.env.DOMAIN_NAME || '',
};

const app = new App();

new NodeGRPCDemo(app, 'NodeGRPCDemo', {
  ...stackProps,
  env: devEnv,
});

app.synth();
