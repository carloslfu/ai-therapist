import * as stream from "stream";

let audioElements: HTMLAudioElement[] = [];

export function stopAllAudio() {
  audioElements.forEach((element) => {
    element.pause();
    element.remove();
  });

  audioElements = [];
}

export function playAudioFromResponse(
  stream: stream.Readable,
  onAudioLoaded: () => void,
  onIsPlayingChange: (isPlaying: boolean) => void,
  onIsLoadingChange: (isLoading: boolean) => void
) {
  if (!MediaSource.isTypeSupported("audio/mpeg")) {
    throw new Error("Unsupported MIME type or codec: audio/mpeg");
  }

  const mediaSource = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(mediaSource);
  audio.volume = 0.5;
  audio.loop = false;

  // stop all other audio elements, and remove them from the audioElements array and dispose of them
  stopAllAudio();

  audioElements.push(audio);

  mediaSource.addEventListener("sourceopen", () => {
    const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
    onAudioLoaded();
    readAudioChunks(stream, sourceBuffer, mediaSource);
    onIsLoadingChange(false);
    onIsPlayingChange(true);
    audio.play();
  });

  audio.onended = () => {
    onIsPlayingChange(false);
  };

  audio.addEventListener("error", (e) => {
    console.error("Error playing audio", e);
  });
}

async function readAudioChunks(
  reader: stream.Readable,
  sourceBuffer: SourceBuffer,
  mediaSource: MediaSource
) {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of reader) {
      chunks.push(chunk);
      await appendBufferAsync(sourceBuffer, chunk);
    }

    // Repeat the audio data
    for (const chunk of chunks) {
      await appendBufferAsync(sourceBuffer, chunk);
    }

    mediaSource.endOfStream();
  } catch (error) {
    console.error("Error reading audio chunks:", error);
    mediaSource.endOfStream("decode");
  }
}

function appendBufferAsync(
  sourceBuffer: SourceBuffer,
  chunk: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!sourceBuffer.updating) {
      sourceBuffer.appendBuffer(chunk);
      sourceBuffer.addEventListener("updateend", () => resolve(), {
        once: true,
      });
      sourceBuffer.addEventListener("error", (e) => reject(e), { once: true });
    } else {
      sourceBuffer.addEventListener(
        "updateend",
        () => {
          sourceBuffer.appendBuffer(chunk);
          sourceBuffer.addEventListener("updateend", () => resolve(), {
            once: true,
          });
          sourceBuffer.addEventListener("error", (e) => reject(e), {
            once: true,
          });
        },
        { once: true }
      );
    }
  });
}
