import { PassThrough } from 'stream';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { config } from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';

config();
const PROTO_PATH = 'audio.proto';
const TARGET = process.env.TARGET;
const COUNT_FREQUENCY = Number(process.env.COUNT_FREQUENCY) || 30;
const WAV_FILE = process.env.WAV_FILE;

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const audio_proto: any = grpc.loadPackageDefinition(packageDefinition).audio;

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
}

void main();

async function processFfmpeg(fileName: string): Promise<{
  audioStream: PassThrough;
}> {
  console.log('Processing with ffmpeg');
  const audioStream = new PassThrough();

  let count: number = 0;

  ffmpeg(fileName)
    .native()
    .output(audioStream)
    .format('wav')
    .audioCodec('pcm_s16le')
    .audioBitrate(8000)
    .on('error', (error: { message: string }) => {
      console.log('Cannot process: ' + error.message);
    })
    .on('stderr', (data: any) => {
      if (!COUNT_FREQUENCY) {
        if (count % COUNT_FREQUENCY === 0) {
          console.info(`Stream: ${data}`);
        }
      }
      count++;
    })
    .run();

  return { audioStream };
}
