import { PassThrough, Readable } from 'stream';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  LanguageCode,
  MediaEncoding,
} from '@aws-sdk/client-transcribe-streaming';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = 'audio.proto';
const REGION = process.env.REGION || 'us-east-1';

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const audio_proto: any = grpc.loadPackageDefinition(packageDefinition).audio;

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

async function startTranscription(
  stream: Readable,
  call: grpc.ServerWritableStream<any, any>,
) {
  const client = new TranscribeStreamingClient({ region: REGION });
  console.log('Starting Transcribe');

  const audioStream = async function* () {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      yield { AudioEvent: { AudioChunk: buffer } };
    }
  };

  try {
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: LanguageCode.EN_US,
      MediaEncoding: MediaEncoding.PCM,
      MediaSampleRateHertz: 16000,
      AudioStream: audioStream(),
    });

    const response = await client.send(command);

    if (response.TranscriptResultStream) {
      for await (const event of response.TranscriptResultStream) {
        if (
          event.TranscriptEvent &&
          event.TranscriptEvent &&
          event.TranscriptEvent.Transcript &&
          event.TranscriptEvent.Transcript.Results &&
          event.TranscriptEvent.Transcript.Results.length > 0 &&
          event.TranscriptEvent.Transcript.Results[0].IsPartial == false &&
          event.TranscriptEvent.Transcript.Results[0].Alternatives
        ) {
          console.log(
            'Transcription: ',
            JSON.stringify(
              event.TranscriptEvent.Transcript.Results[0].Alternatives[0]
                .Transcript,
            ),
          );
          call.write({
            message: JSON.stringify(
              event.TranscriptEvent.Transcript.Results[0].Alternatives[0]
                .Transcript,
            ),
          });
        }
      }
    } else {
      console.error('TranscriptResultStream is undefined');
      call.write({ message: 'TranscriptResultStream is undefined' });
    }
  } catch (error) {
    console.error('Error in transcription:', error);
    call.write({ message: error });
  }
}
