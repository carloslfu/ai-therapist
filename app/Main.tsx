"use client";

import { useEffect, useRef, useCallback, useState } from "react";

import { RealtimeClient } from "@openai/realtime-api-beta";
import { ElevenLabsClient } from "elevenlabs";
import { ItemType } from "@openai/realtime-api-beta/dist/lib/client.js";
import { WavRecorder, WavStreamPlayer } from "@/lib/wavtools/index.js";
import {
  createSoundEffectPrompt,
  createImagePrompt,
  createInstructions,
} from "../utils/conversation_config";
import { WavRenderer } from "../utils/wav_renderer";

import { X, Edit, ArrowUp, ArrowDown, Mic } from "react-feather";
import { Button } from "../components/button/Button";

import * as fal from "@fal-ai/serverless-client";

import { playAudioFromResponse } from "../lib/wavtools/lib/elevenlabs_player";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const defaultImageUrl =
  "https://fal.media/files/panda/PzxtRFOGjqQKpHl9UnE_R_50a29e0140e6470baeba760cfc1b0362.jpg";

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

export default function Main() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = localStorage.getItem("tmp::voice_api_key") || "";
  if (apiKey !== "") {
    localStorage.setItem("tmp::voice_api_key", apiKey);
  }

  // ElevenLabs API Key
  const elevenLabsApiKey =
    localStorage.getItem("tmp::elevenlabs_api_key") || "";

  if (elevenLabsApiKey !== "") {
    localStorage.setItem("tmp::elevenlabs_api_key", elevenLabsApiKey);
  }

  const falApiKey = localStorage.getItem("tmp::fal_api_key") || "";

  if (falApiKey !== "") {
    localStorage.setItem("tmp::fal_api_key", falApiKey);
  }

  // User's name
  const [userName, setUserName] = useState(
    localStorage.getItem("tmp::user_name") || ""
  );

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
  // const [canPushToTalk, setCanPushToTalk] = useState(false);
  // const [isRecording, setIsRecording] = useState(false);
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

  const [imageUrl, setImageUrl] = useState<string | null>(defaultImageUrl);

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
    if (!userName) {
      alert("Please enter your name before starting the session.");
      return;
    }

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
        text: `Hello! My name is ${userName}.`,
      },
    ]);

    if (client.getTurnDetectionType() === "server_vad") {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, [userName]);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setImageUrl(defaultImageUrl);

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
      document.body.querySelectorAll(".conversation-content")
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

    client.updateSession({
      instructions: createInstructions(userName),
      temperature: 0.6,
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad" },
    });

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

  const lastGeneratedTimestamp = useRef(0);
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
    const currentTime = Date.now();
    const timeSinceLastGenerated = currentTime - lastGeneratedTimestamp.current;

    if (
      items.length === 0 ||
      isGeneratingSoundEffectRef.current ||
      (items.length > 1 && items[items.length - 1].role !== "user") ||
      items.length <= 2 ||
      timeSinceLastGenerated < 60000
    ) {
      return;
    }

    const lastFiveMessages = items.slice(-5);

    isGeneratingSoundEffectRef.current = true;

    console.log("generating sound effect");

    async function generate() {
      const imageDescription = await generateText({
        model: openai("gpt-4o-2024-08-06"),
        prompt: createImagePrompt(lastFiveMessages),
        maxTokens: 4000,
        temperature: 0.3,
      });

      const imagePrompt = imageDescription.text;

      console.log("----- imagePrompt", imagePrompt);

      const imageResult = await fal.subscribe("fal-ai/flux-pro/v1.1", {
        input: {
          prompt: imagePrompt,
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            update.logs.map((log) => log.message).forEach(console.log);
          }
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imageUrlResult = (imageResult as any).images[0].url;

      console.log("----- imageUrlResult", imageUrlResult);

      setImageUrl(imageUrlResult);

      // ---- Audio generation

      const soundDescription = await generateText({
        model: openai("gpt-4o-2024-08-06"),
        prompt: createSoundEffectPrompt(imagePrompt),
        maxTokens: 4000,
        temperature: 0.3,
      });

      const soundPrompt = soundDescription.text.slice(0, 420);

      console.log("----- soundPrompt", soundPrompt);

      const audio =
        await elevenLabsClientRef.current.textToSoundEffects.convert({
          text: soundPrompt,
          duration_seconds: 22,
          prompt_influence: 0.3,
        });

      setTimeout(() => {
        console.log("playing sound effect");

        playAudioFromResponse(
          audio,
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

    generate();
  }, [items]);

  /**
   * Render the application
   */
  return (
    <div className="flex flex-col h-screen">
      <div className="p-2 bg-gray-100 flex items-center justify-between">
        <h1 className="text-lg font-bold px-2 text-blue-600">
          AI Therapist (ASMR)
        </h1>
        <div className="flex space-x-2">
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`OpenAI key: ${apiKey.slice(0, 3)}...`}
            onClick={() => resetAPIKey()}
          />
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`ElevenLabs key: ${elevenLabsApiKey.slice(0, 3)}...`}
            onClick={() => resetElevenLabsAPIKey()}
          />
          <Button
            icon={Edit}
            iconPosition="end"
            buttonStyle="flush"
            label={`Fal key: ${falApiKey.slice(0, 3)}...`}
            onClick={() => resetFalAPIKey()}
          />
        </div>
      </div>
      <Tabs
        defaultValue="user"
        className="flex-grow overflow-hidden max-h-[calc(100vh-100px)]"
      >
        <TabsList className="bg-white border-b">
          <TabsTrigger value="user">User View</TabsTrigger>
          <TabsTrigger value="debug">Debug View</TabsTrigger>
        </TabsList>
        <TabsContent value="user" className="h-full overflow-auto p-4">
          <div className="h-full flex flex-row">
            <div className="w-1/2 pr-2">
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt="Generated image"
                  className="w-full h-auto mb-4 rounded-lg"
                />
              )}
            </div>
            <div className="w-1/2 pl-2 flex flex-col">
              <div className="flex-grow overflow-hidden bg-white rounded-lg shadow flex flex-col">
                <h2 className="text-lg font-semibold p-4 border-b">
                  Conversation
                </h2>
                <div className="flex-grow overflow-y-auto p-4 conversation-content">
                  {!items.length && (
                    <p>Start a conversation by clicking the button below.</p>
                  )}
                  {items.map((conversationItem) => (
                    <div key={conversationItem.id} className="mb-4">
                      <div
                        className={`font-bold ${
                          conversationItem.role === "user"
                            ? "text-blue-600"
                            : "text-green-600"
                        }`}
                      >
                        {conversationItem.role === "assistant"
                          ? "therapist"
                          : (
                              conversationItem.role || conversationItem.type
                            ).replaceAll("_", " ")}
                      </div>
                      <div className="mt-1">
                        {conversationItem.formatted.transcript ||
                          conversationItem.formatted.text ||
                          "(truncated)"}
                        {conversationItem.formatted.file && (
                          <audio
                            src={conversationItem.formatted.file.url}
                            controls
                            className="mt-2"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="debug" className="h-full overflow-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-4">Events</h2>
              <div ref={eventsScrollRef} className="h-64 overflow-auto">
                {!realtimeEvents.length && <p>Awaiting connection...</p>}
                {realtimeEvents.map((realtimeEvent) => {
                  const count = realtimeEvent.count;
                  const event = { ...realtimeEvent.event };
                  if (event.type === "input_audio_buffer.append") {
                    event.audio = `[trimmed: ${event.audio.length} bytes]`;
                  } else if (event.type === "response.audio.delta") {
                    event.delta = `[trimmed: ${event.delta.length} bytes]`;
                  }
                  return (
                    <div key={event.event_id} className="mb-2">
                      <div className="text-sm text-gray-500">
                        {formatTime(realtimeEvent.time)}
                      </div>
                      <div
                        className="cursor-pointer"
                        onClick={() => {
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
                        <span
                          className={`font-semibold ${
                            event.type === "error"
                              ? "text-red-600"
                              : realtimeEvent.source === "client"
                              ? "text-blue-600"
                              : "text-green-600"
                          }`}
                        >
                          {realtimeEvent.source === "client" ? (
                            <ArrowUp className="inline" />
                          ) : (
                            <ArrowDown className="inline" />
                          )}
                          {event.type === "error"
                            ? "Error!"
                            : realtimeEvent.source}
                        </span>
                        <span className="ml-2">
                          {event.type}
                          {count && ` (${count})`}
                        </span>
                      </div>
                      {!!expandedEvents[event.event_id] && (
                        <pre className="text-xs bg-gray-100 p-2 mt-1 rounded">
                          {JSON.stringify(event, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-4">Conversation</h2>
              <div className="h-96 overflow-auto">
                {!items.length && <p>Awaiting connection...</p>}
                {items.map((conversationItem) => (
                  <div key={conversationItem.id} className="mb-4">
                    <div className="flex justify-between items-center">
                      <span
                        className={`font-bold ${
                          conversationItem.role === "user"
                            ? "text-blue-600"
                            : "text-green-600"
                        }`}
                      >
                        {conversationItem.role === "assistant"
                          ? "therapist"
                          : (
                              conversationItem.role || conversationItem.type
                            ).replaceAll("_", " ")}
                      </span>
                      <button
                        onClick={() =>
                          deleteConversationItem(conversationItem.id)
                        }
                        className="text-red-600 hover:text-red-800"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="mt-1">
                      {conversationItem.type === "function_call_output" && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
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
                          className="mt-2"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-4">set_memory()</h2>
              <pre className="text-xs bg-gray-100 p-2 rounded">
                {JSON.stringify(memoryKv, null, 2)}
              </pre>
            </div> */}
          </div>
        </TabsContent>
      </Tabs>

      {/* spacer */}
      <div className="h-32" />

      <div className="fixed bottom-0 left-0 right-0 bg-white p-4 shadow-lg flex items-center justify-center">
        <div className="flex items-center space-x-4">
          <canvas ref={clientCanvasRef} className="w-20 h-10" />
          <input
            type="text"
            value={userName}
            onChange={(e) => {
              setUserName(e.target.value);
              localStorage.setItem("tmp::user_name", e.target.value);
            }}
            placeholder="Enter your name"
            className="px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <button
            className={cn(
              "flex items-center justify-center px-6 py-3 rounded-lg text-base font-medium transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-offset-2",
              isConnected
                ? "bg-gray-200 text-gray-800 hover:bg-gray-300 focus:ring-gray-500"
                : "bg-blue-200 text-blue-800 hover:bg-blue-300 focus:ring-blue-300"
            )}
            onClick={isConnected ? disconnectConversation : connectConversation}
          >
            {isConnected ? (
              <>
                <X className="mr-3 h-5 w-5 text-red-600" />
                <span className="text-lg">Finish session</span>
              </>
            ) : (
              <>
                <Mic className="mr-3 h-5 w-5 text-blue-600" />
                <span className="text-lg">Start session</span>
              </>
            )}
          </button>
          <canvas ref={serverCanvasRef} className="w-20 h-10" />
        </div>
      </div>
    </div>
  );
}
