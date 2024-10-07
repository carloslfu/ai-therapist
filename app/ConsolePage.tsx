"use client";

import { useEffect, useRef, useCallback, useState } from "react";

import { RealtimeClient } from "@openai/realtime-api-beta";
import { ElevenLabsClient } from "elevenlabs";
import { ItemType } from "@openai/realtime-api-beta/dist/lib/client.js";
import { WavRecorder, WavStreamPlayer } from "@/lib/wavtools/index.js";
import {
  instructions,
  createSoundEffectPrompt,
} from "../utils/conversation_config";
import { WavRenderer } from "../utils/wav_renderer";

import { X, Edit, Zap, ArrowUp, ArrowDown } from "react-feather";
import { Button } from "../components/button/Button";
import { Toggle } from "../components/toggle/Toggle";

import * as fal from "@fal-ai/serverless-client";

import "./ConsolePage.scss";
import { playAudioFromResponse } from "../lib/wavtools/lib/elevenlabs_player";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: "client" | "server";
  count?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: { [key: string]: any };
}

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey =
    localStorage.getItem("tmp::voice_api_key") ||
    prompt("OpenAI API Key") ||
    "";
  if (apiKey !== "") {
    localStorage.setItem("tmp::voice_api_key", apiKey);
  }

  // ElevenLabs API Key
  const elevenLabsApiKey =
    localStorage.getItem("tmp::elevenlabs_api_key") ||
    prompt("ElevenLabs API Key") ||
    "";

  if (elevenLabsApiKey !== "") {
    localStorage.setItem("tmp::elevenlabs_api_key", elevenLabsApiKey);
  }

  const falApiKey =
    localStorage.getItem("tmp::fal_api_key") || prompt("Fal API Key") || "";

  if (falApiKey !== "") {
    localStorage.setItem("tmp::fal_api_key", falApiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient({
      apiKey: apiKey,
      dangerouslyAllowAPIKeyInBrowser: true,
    })
  );

  const elevenLabsClientRef = useRef<ElevenLabsClient>(
    new ElevenLabsClient({ apiKey: elevenLabsApiKey })
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + "";
      while (s.length < 2) {
        s = "0" + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * When you click the API key
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt("OpenAI API Key");
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem("tmp::voice_api_key", apiKey);
      window.location.reload();
    }
  }, []);

  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const resetElevenLabsAPIKey = useCallback(() => {
    const elevenLabsApiKey = prompt("ElevenLabs API Key");
    if (elevenLabsApiKey !== null) {
      localStorage.clear();
      localStorage.setItem("tmp::elevenlabs_api_key", elevenLabsApiKey);
      window.location.reload();
    }
  }, []);

  const resetFalAPIKey = useCallback(() => {
    const falApiKey = prompt("Fal API Key");
    if (falApiKey !== null) {
      localStorage.clear();
      localStorage.setItem("tmp::fal_api_key", falApiKey);
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    fal.config({
      credentials: falApiKey,
    });
  }, [falApiKey]);

  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Set state variables
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // Connect to microphone
    await wavRecorder.begin();

    // Connect to audio output
    await wavStreamPlayer.connect();

    // Connect to realtime API
    await client.connect();
    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Hello!`,
        // text: `For testing purposes, I want you to list ten car brands. Number each item, e.g. "one (or whatever number you are one): the item name".`
      },
    ]);

    if (client.getTurnDetectionType() === "server_vad") {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setImageUrl(null);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * In push-to-talk mode, start recording
   * .appendInputAudio() for each sample
   */
  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  };

  /**
   * In push-to-talk mode, stop recording
   */
  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  };

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === "none" && wavRecorder.getStatus() === "recording") {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === "none" ? null : { type: "server_vad" },
    });
    if (value === "server_vad" && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    setCanPushToTalk(value === "none");
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll("[data-conversation-content]")
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext("2d");
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies("voice")
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              "#0099ff",
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext("2d");
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies("voice")
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              "#009900",
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: instructions, temperature: 0.6 });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: "whisper-1" } });

    // Add tools
    // client.addTool(
    //   {
    //     name: 'set_memory',
    //     description: 'Saves important data about the user into memory.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         key: {
    //           type: 'string',
    //           description:
    //             'The key of the memory value. Always use lowercase and underscores, no other characters.',
    //         },
    //         value: {
    //           type: 'string',
    //           description: 'Value can be anything represented as a string',
    //         },
    //       },
    //       required: ['key', 'value'],
    //     },
    //   },
    //   async ({ key, value }: { [key: string]: any }) => {
    //     setMemoryKv((memoryKv) => {
    //       const newKv = { ...memoryKv };
    //       newKv[key] = value;
    //       return newKv;
    //     });
    //     return { ok: true };
    //   }
    // );

    // client.addTool(
    //   {
    //     name: 'generate_sound_effect',
    //     description:
    //       'Use this tool to generate a sound effect. Examples: ASMR tapping, ASMR rubbing, relaxing nature sounds, coast waves, etc.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         sound: {
    //           type: 'string',
    //           description: 'Description of sound effect to generate.',
    //         },
    //         duration: {
    //           type: 'number',
    //           description: 'Duration of the sound effect in seconds.',
    //         },
    //       },
    //       required: ['sound', 'duration'],
    //     },
    //   },
    //   async ({ sound, duration }: { [key: string]: any }) => {
    //     console.log(`generating sound (${duration}s): ${sound}`);

    //     const repeatTimes = Math.ceil(duration / 22);

    //     const audio =
    //       await elevenLabsClientRef.current.textToSoundEffects.convert({
    //         text: sound,
    //         duration_seconds:
    //           duration > 22 ? 22 : duration < 0.5 ? 0.5 : duration,
    //         prompt_influence: 0.3,
    //       });

    //     console.log(`sound effect generated`);

    //     setTimeout(() => {
    //       playAudioFromResponse(
    //         audio,
    //         repeatTimes,
    //         () => {},
    //         () => {},
    //         () => {}
    //       );
    //     });

    //     return { ok: true };
    //   }
    // );

    // client.addTool(
    //   {
    //     name: 'generate_image',
    //     description:
    //       'Use this tool to generate an image. Examples: a relaxing river, a relaxing ocean, a relaxing forest, a relaxing mountain, a relaxing waterfall, a relaxing beach, a relaxing a lake, a relaxing a landscape.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         image: {
    //           type: 'string',
    //           description: 'Description of image to generate.',
    //         },
    //       },
    //       required: ['image'],
    //     },
    //   },
    //   async ({ image }: { image: string }) => {
    //     console.log(`generating image: ${image}`);

    //     const result = await fal.subscribe('fal-ai/flux-pro/v1.1', {
    //       input: {
    //         prompt: image,
    //       },
    //       logs: true,
    //       onQueueUpdate: (update) => {
    //         if (update.status === 'IN_PROGRESS') {
    //           update.logs.map((log) => log.message).forEach(console.log);
    //         }
    //       },
    //     });

    //     console.log('image generated', (result as any).images[0].url);

    //     setImageUrl((result as any).images[0].url);

    //     return { ok: true };
    //   }
    // );

    // handle realtime events from client + server for event logging
    client.on("realtime.event", (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on("error", (event: any) => console.error(event));
    client.on("conversation.interrupted", async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on("conversation.updated", async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === "completed" && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  const isPlayingRef = useRef(false);
  const isGeneratingSoundEffectRef = useRef(false);

  const [openai] = useState(() =>
    createOpenAI({
      apiKey,
    })
  );

  /**
   * Generate sound effects
   */
  useEffect(() => {
    if (
      items.length === 0 ||
      isPlayingRef.current ||
      isGeneratingSoundEffectRef.current
    ) {
      return;
    }

    isGeneratingSoundEffectRef.current = true;

    console.log("generating sound effect");

    async function run() {
      const repeatTimes = 3;

      const soundDescription = await generateText({
        model: openai("gpt-4o-2024-08-06"),
        prompt: createSoundEffectPrompt(items),
        maxTokens: 4000,
        temperature: 0.3,
      });

      const sound = soundDescription.text;

      const audio =
        await elevenLabsClientRef.current.textToSoundEffects.convert({
          text: sound,
          duration_seconds: 22,
          prompt_influence: 0.3,
        });

      setTimeout(() => {
        console.log("playing sound effect");

        playAudioFromResponse(
          audio,
          repeatTimes,
          () => {},
          (isPlaying) => {
            console.log("isPlaying", isPlaying);
            isPlayingRef.current = isPlaying;

            if (!isPlaying) {
              console.log("sound effect finished playing");
            }
          },
          () => {}
        );
      });

      console.log("sound effect generation complete");

      isGeneratingSoundEffectRef.current = false;
    }

    run();
  }, [items]);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <span>AI Therapist (ASMR)</span>
        </div>
        <div className="content-api-key">
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`api key: ${apiKey.slice(0, 3)}...`}
            onClick={() => resetAPIKey()}
          />
        </div>
        <div className="content-api-key">
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`ElevenLabs key: ${elevenLabsApiKey.slice(0, 3)}...`}
            onClick={() => resetElevenLabsAPIKey()}
          />
        </div>
        <div className="content-api-key">
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`Fal key: ${falApiKey.slice(0, 3)}...`}
            onClick={() => resetFalAPIKey()}
          />
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div>
            <div className="content-block-title">events</div>
            <div className="content-block-body" ref={eventsScrollRef}>
              {!realtimeEvents.length && `awaiting connection...`}
              {realtimeEvents.map((realtimeEvent) => {
                const count = realtimeEvent.count;
                const event = { ...realtimeEvent.event };
                if (event.type === "input_audio_buffer.append") {
                  event.audio = `[trimmed: ${event.audio.length} bytes]`;
                } else if (event.type === "response.audio.delta") {
                  event.delta = `[trimmed: ${event.delta.length} bytes]`;
                }
                return (
                  <div className="event" key={event.event_id}>
                    <div className="event-timestamp">
                      {formatTime(realtimeEvent.time)}
                    </div>
                    <div className="event-details">
                      <div
                        className="event-summary"
                        onClick={() => {
                          // toggle event details
                          const id = event.event_id;
                          const expanded = { ...expandedEvents };
                          if (expanded[id]) {
                            delete expanded[id];
                          } else {
                            expanded[id] = true;
                          }
                          setExpandedEvents(expanded);
                        }}
                      >
                        <div
                          className={`event-source ${
                            event.type === "error"
                              ? "error"
                              : realtimeEvent.source
                          }`}
                        >
                          {realtimeEvent.source === "client" ? (
                            <ArrowUp />
                          ) : (
                            <ArrowDown />
                          )}
                          <span>
                            {event.type === "error"
                              ? "error!"
                              : realtimeEvent.source}
                          </span>
                        </div>
                        <div className="event-type">
                          {event.type}
                          {count && ` (${count})`}
                        </div>
                      </div>
                      {!!expandedEvents[event.event_id] && (
                        <div className="event-payload">
                          {JSON.stringify(event, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-block conversation">
            <div className="content-block-title">conversation</div>
            <div className="content-block-body" data-conversation-content>
              {!items.length && `awaiting connection...`}
              {items.map((conversationItem) => {
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ""}`}>
                      <div>
                        {(
                          conversationItem.role || conversationItem.type
                        ).replaceAll("_", " ")}
                      </div>
                      <div
                        className="close"
                        onClick={() =>
                          deleteConversationItem(conversationItem.id)
                        }
                      >
                        <X />
                      </div>
                    </div>
                    <div className={`speaker-content`}>
                      {/* tool response */}
                      {conversationItem.type === "function_call_output" && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
                      {/* tool call */}
                      {!!conversationItem.formatted.tool && (
                        <div>
                          {conversationItem.formatted.tool.name}(
                          {conversationItem.formatted.tool.arguments})
                        </div>
                      )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === "user" && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              (conversationItem.formatted.audio?.length
                                ? "(awaiting transcript)"
                                : conversationItem.formatted.text ||
                                  "(item sent)")}
                          </div>
                        )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === "assistant" && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              conversationItem.formatted.text ||
                              "(truncated)"}
                          </div>
                        )}
                      {conversationItem.formatted.file && (
                        <audio
                          src={conversationItem.formatted.file.url}
                          controls
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-actions">
            <Toggle
              defaultValue={false}
              labels={["manual", "vad"]}
              values={["none", "server_vad"]}
              onChange={(_, value) => changeTurnEndType(value)}
            />
            <div className="spacer" />
            {isConnected && canPushToTalk && (
              <Button
                label={isRecording ? "release to send" : "push to talk"}
                buttonStyle={isRecording ? "alert" : "regular"}
                disabled={!isConnected || !canPushToTalk}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
            )}
            <div className="spacer" />
            <Button
              label={isConnected ? "disconnect" : "connect"}
              iconPosition={isConnected ? "end" : "start"}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? "regular" : "action"}
              onClick={
                isConnected ? disconnectConversation : connectConversation
              }
            />
          </div>
        </div>
        <div className="content-right">
          <div className="content-block map">
            {imageUrl && <img src={imageUrl} />}
          </div>
          <div className="content-block kv">
            <div className="content-block-title">set_memory()</div>
            <div className="content-block-body content-kv">
              {JSON.stringify(memoryKv, null, 2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}