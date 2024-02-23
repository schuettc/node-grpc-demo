import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ApplicationProtocolVersion,
  ListenerCertificate,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  ManagedPolicy,
  Role,
  PolicyStatement,
  PolicyDocument,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { ARecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

interface ECSResourcesProps {
  vpc: Vpc;
  logLevel: string;
  applicationLoadBalancerSecurityGroup: SecurityGroup;
  certificate: Certificate;
  hostedZone: IHostedZone;
}

export class ECSResources extends Construct {
  fargateService: FargateService;
  applicationLoadBalancer: ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ECSResourcesProps) {
    super(scope, id);

    const cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'gRPCServer',
    });

    const ecsTaskRole = new Role(this, 'ecsTaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        ['TranscribePolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['transcribe:StartStreamTranscription'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    this.applicationLoadBalancer = new ApplicationLoadBalancer(
      this,
      'applicationLoadBalancer',
      {
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        internetFacing: true,
        securityGroup: props.applicationLoadBalancerSecurityGroup,
      },
    );

    const ecsTask = new FargateTaskDefinition(this, 'ecsTask', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: ecsTaskRole,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.ARM64,
      },
    });

    ecsTask.addContainer('gRPCServerContainer', {
      image: ContainerImage.fromAsset('src/resources/gRPCServer'),
      containerName: 'gRPCServer',
      portMappings: [{ containerPort: 50051, hostPort: 50051 }],
      logging: LogDrivers.awsLogs({
        streamPrefix: 'gRPCServer',
      }),
      environment: {},
    });

    const taskSecurityGroup = new SecurityGroup(this, 'taskSecurityGroups', {
      vpc: props.vpc,
    });

    this.fargateService = new FargateService(this, 'gRPCServerFargateService', {
      cluster: cluster,
      taskDefinition: ecsTask,
      assignPublicIp: true,
      desiredCount: 1,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [taskSecurityGroup],
    });

    const scaling = this.fargateService.autoScaleTaskCount({ maxCapacity: 10 });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
    });

    const grpcServerTargetGroup = new ApplicationTargetGroup(
      this,
      'gRPCServerTargetGroup',
      {
        vpc: props.vpc,
        port: 50051,
        protocol: ApplicationProtocol.HTTP,
        protocolVersion: ApplicationProtocolVersion.GRPC,
        targets: [this.fargateService],
        healthCheck: {
          healthyGrpcCodes: '12',
        },
      },
    );

    this.applicationLoadBalancer.addListener('fargateListener', {
      port: 50051,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [
        ListenerCertificate.fromCertificateManager(props.certificate),
      ],
      open: true,
      defaultTargetGroups: [grpcServerTargetGroup],
    });

    props.applicationLoadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(50051),
    );

    new ARecord(this, 'grpcARecord', {
      zone: props.hostedZone,
      recordName: 'grpc',
      target: RecordTarget.fromAlias(
        new LoadBalancerTarget(this.applicationLoadBalancer),
      ),
    });
  }
}
