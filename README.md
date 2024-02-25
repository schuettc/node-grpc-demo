# gRPC Streaming Audio with Node

This demo will guide you through the process of deploying a [gRPC](https://grpc.io/) server that is capable of receiving streaming audio from a gRPC client and processing that audio with [Amazon Transcribe](https://aws.amazon.com/transcribe/) and returning the result to the client.

## Server Infrastructure

![gRPCServerOverview](/images/gRPCServerOverview.png)

This demo will deploy a [Fargate](https://aws.amazon.com/fargate/) container that runs the gRPC server. This gRPC server will be available through an [Application Load Balancer](https://aws.amazon.com/elasticloadbalancing/application-load-balancer/) that is enabled with HTTPS through a [Certificate](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html) generated through [AWS Certificate Manager](https://aws.amazon.com/certificate-manager/).

### Certificate Manager

```typescript
this.hostedZone = HostedZone.fromLookup(this, 'HostedZone', {
  domainName: props.domainName,
});

this.certificate = new Certificate(this, 'Certificate', {
  domainName: `grpc.${props.domainName}`,
  validation: CertificateValidation.fromDns(this.hostedZone),
});
```

Using a provided domain name, the CDK will lookup the associated [HostedZone](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-working-with.html) and create a Certificate that will be associated with the Application Load Balancer.

### Application Load Balancer

```typescript
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
  certificates: [ListenerCertificate.fromCertificateManager(props.certificate)],
  open: true,
  defaultTargetGroups: [grpcServerTargetGroup],
});

props.applicationLoadBalancerSecurityGroup.addIngressRule(
  Peer.anyIpv4(),
  Port.tcp(50051),
);
```

This will create an Application Load Balancer [Target Group](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) that uses `ApplicationProtocolVersion.GRPC` as the protocol version. Additionally, the `healthCheck` will look for gRPC codes in the response from the gRPC server. The [Listener](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html) associated with the Application Load Balancer uses HTTPS and the previously created Certificate. The Listener will use port `50051` and forward to port `50051` on the Fargate task. This port is also opened on the Application Load Balancer Security Group.

### Route 53

```typescript
new ARecord(this, 'grpcARecord', {
  zone: props.hostedZone,
  recordName: 'grpc',
  target: RecordTarget.fromAlias(
    new LoadBalancerTarget(this.applicationLoadBalancer),
  ),
});
```

Finally, an [A Record](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ResourceRecordTypes.html#AFormat) will be created that points to the Application Load Balancer alias use the record name `grpc`. This will create a record `grpc.example.com` that can be used with the Application Load Balancer.

## gRPC Server

### Server initialization

```typescript
function main() {
  const server = new grpc.Server();
  server.addService(audio_proto.AudioStreamer.service, { streamAudio });
  server.bindAsync(
    '0.0.0.0:50051',
    grpc.ServerCredentials.createInsecure(),
    () => {
      server.start();
      console.log('gRPC server started on port 50051');
    },
  );
}

main();
```

The main function of the server code, is used to create the server that is listening on port `50051` with HTTP. The Application Load Balancer will provide the TLS security so HTTP can be used here.

### streamAudio Function

```typescript
function streamAudio(call: grpc.ServerWritableStream<any, any>) {
  console.log('Streaming audio data received from client.');

  const audioStream = new PassThrough();

  startTranscription(audioStream, call).catch((error) => {
    console.error('Transcription error:', error);
    call.write({ message: error });
  });

  call.on('data', (data: any) => {
    audioStream.write(data.audioData);
  });

  call.on('end', async () => {
    console.log('Streaming completed.');
    audioStream.end();
  });

  audioStream.on('end', () => {
    console.log('Transcribing ended.');
  });
}
```

Now, when a stream arrives, the `streamAudio` function will begin processing the stream. In this example, it involves three major steps:

1. Create `audioStream` PassThrough Stream
2. Start `startTranscription` function with the `audioStream`
3. Write data to the `audioStream` from the gRPC stream as it arrives

### Transcribe the stream

```typescript
const audioStream = async function* () {
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    yield { AudioEvent: { AudioChunk: buffer } };
  }
};

const command = new StartStreamTranscriptionCommand({
  LanguageCode: LanguageCode.EN_US,
  MediaEncoding: MediaEncoding.PCM,
  MediaSampleRateHertz: 16000,
  AudioStream: audioStream(),
});

const response = await client.send(command);
```

This will send the stream to Transcribe for processing. Once we get a response back from Transcribe, we will write this back to the gRPC client via the stream.

```typescript
call.write({
  message: JSON.stringify(
    event.TranscriptEvent.Transcript.Results[0].Alternatives[0].Transcript,
  ),
});
```

## gRPC Client

```typescript
async function main() {
  let target: string = 'localhost:50051';
  let credentials = grpc.credentials.createInsecure();

  if (TARGET) {
    target = `${TARGET}:50051`;
    credentials = grpc.credentials.createSsl();
  }

  console.log(`Using target: ${target}`);

  if (!WAV_FILE) {
    throw new Error('WAV_FILE required');
  }

  console.log(`Using source: ${WAV_FILE}`);

  const { audioStream } = await processFfmpeg(WAV_FILE);
}
```

The main client function will determine the `TARGET` and `WAV_FILE` to be used. This client can be used both locally or with the deployed gRPC server. A `WAV_FILE` is required and can be stored in the `client\src` directory and will be copied over during the Docker build. If the `WAV_FILE` is a stereo file with each channel a separate user, they will be muxed together when sent to the gRPC server. The result will be that the transcription is the combined result of both channels. If you want to get a single channel, you can modify the `ffmpeg` to only pass one channel, or separate the `WAV_FILE` before sending.

### ffmpeg Processing

```typescript
async function processFfmpeg(fileName: string): Promise<{
  audioStream: PassThrough;
}> {
  console.log('Processing with ffmpeg');
  const audioStream = new PassThrough();

  ffmpeg(fileName)
    .native()
    .output(audioStream)
    .format('wav')
    .audioCodec('pcm_s16le')
    .audioBitrate(8000)
    .on('error', (error: { message: string }) => {
      console.log('Cannot process: ' + error.message);
    })
    .run();

  return { audioStream };
}
```

This demo uses `ffmpeg` to ensure the audio being streamed is sent at the correct rate and with the correct formatting.

### Streaming

```typescript
const client = new audio_proto.AudioStreamer(target, credentials);
const chunkSize = 1024;
const call = client.streamAudio();

audioStream.on('data', (chunk) => {
  let offset = 0;
  while (offset < chunk.length) {
    const end = Math.min(offset + chunkSize, chunk.length);
    const chunkToSend = chunk.slice(offset, end);
    call.write({ audioData: chunkToSend });
    offset = end;
  }
});

audioStream.on('end', () => {
  console.log('Audio stream ended.');
  call.end();
});

call.on('data', (response: any) => {
  console.log(`${Date.now()}: ${response.message}`);
});

call.on('end', () => {
  console.log('gRPC call ended.');
  process.exit(0);
});

call.on('error', (err: any) => {
  console.error('Error:', err);
});
```

Once the `audioStream` has been created through `processFfmpeg`, when data arrives, it will be written to the gRPC stream in chunks through the client. Responses that are generated on the server (the transcriptions) will be surfaced through the `call.on('data', () => {})` function.

## In Action

![InActionOverview](/images/InActionOverview.png)

In order to test this demo, you can either use it locally or through the deployed Fargate container.

### Deploying

```bash
yarn launch
```

This will deploy the CDK stack to your account. You will need a HostedZone domain in order to use this. The A Record created will be written to the `client\src\.env` file so that you can use the client with this gRPC server.

### Testing

In order to test locally, you will need to start the gRPC server. In the `src\resources\gRPCServer` directory, you can start the gRPC Server Docker container:

```bash
docker-compose run --build grpc-server
```

You will need to have AWS credentials exposed in this container in order to use Transcribe.

In the `client\src` directory, you can start the gRPC Client Docker container:

```bash
docker-compose run --build -e TARGET= grpc-client
```

You can add the the `WAV_FILE` environment variable in the command line as well

```bash
docker-compose run --build -e TARGET= -e WAV_FILE=EXAMPLE.wav grpc-client
```

This will use the localhost as the `TARGET`. If you want to test with the hosted gRPC server and have already deployed it, you can use:

```bash
docker-compose run --build grpc-client
```

### Client Results

![ClientResults](/images//ClientResults.png)

### Server Results

![ServerResults](/images/ServerResults.png)
