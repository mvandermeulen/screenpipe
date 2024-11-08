"use client";
import { useEffect, useState, useRef } from "react";
import { OpenAI } from "openai";
import { generateId, Message } from "ai";
import { useSettings } from "@/lib/hooks/use-settings";
import { ChatMessage } from "@/components/chat-message-v2";
import { useToast } from "@/components/ui/use-toast";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  Loader2,
  Send,
  Square,
  X,
  GripHorizontal,
  RotateCcw,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { platform } from "@tauri-apps/plugin-os";

interface StreamTimeSeriesResponse {
  timestamp: string;
  devices: DeviceFrameResponse[];
}

interface DeviceFrameResponse {
  device_id: string;
  frame: string; // base64 encoded image
  metadata: DeviceMetadata;
  audio: AudioData[];
}

interface DeviceMetadata {
  file_path: string;
  app_name: string;
  window_name: string;
  ocr_text: string;
  timestamp: string;
}

interface AudioData {
  device_name: string;
  is_input: boolean;
  transcription: string;
  audio_file_path: string;
  duration_secs: number;
  start_offset: number;
}

interface TimeRange {
  start: Date;
  end: Date;
}

interface Agent {
  id: string;
  name: string;
  description: string;
  dataSelector: (frames: StreamTimeSeriesResponse[]) => any;
}

const AGENTS: Agent[] = [
  {
    id: "context-master",
    name: "context master",
    description: "analyzes everything: apps, windows, text & audio",
    dataSelector: (frames) =>
      frames.map((frame) => ({
        timestamp: frame.timestamp,
        devices: frame.devices.map((device) => ({
          device_id: device.device_id,
          metadata: device.metadata,
          audio: device.audio,
        })),
      })),
  },
  {
    id: "window-tracker",
    name: "window tracker",
    description: "focuses on app switching patterns",
    dataSelector: (frames) =>
      frames.map((frame) => ({
        timestamp: frame.timestamp,
        windows: frame.devices.map((device) => ({
          app: device.metadata.app_name,
          window: device.metadata.window_name,
        })),
      })),
  },
  {
    id: "text-scanner",
    name: "text scanner",
    description: "analyzes visible text (OCR)",
    dataSelector: (frames) =>
      frames.map((frame) => ({
        timestamp: frame.timestamp,
        text: frame.devices
          .map((device) => device.metadata.ocr_text)
          .filter(Boolean),
      })),
  },
  {
    id: "voice-analyzer",
    name: "voice analyzer",
    description: "focuses on audio transcriptions",
    dataSelector: (frames) =>
      frames.map((frame) => ({
        timestamp: frame.timestamp,
        audio: frame.devices.flatMap((device) => device.audio),
      })),
  },
];

export default function Timeline() {
  const [currentFrame, setCurrentFrame] = useState<DeviceFrameResponse | null>(
    null
  );
  const [frames, setFrames] = useState<StreamTimeSeriesResponse[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedTimeRange, setLoadedTimeRange] = useState<{
    start: Date;
    end: Date;
  } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout>();
  const retryCount = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [selectionRange, setSelectionRange] = useState<TimeRange | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const { settings } = useSettings();
  const { toast } = useToast();
  const [chatMessages, setChatMessages] = useState<Array<Message>>([]);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isAiPanelExpanded, setIsAiPanelExpanded] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const aiPanelRef = useRef<HTMLDivElement>(null);
  const [isHoveringAiPanel, setIsHoveringAiPanel] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDraggingPanel, setIsDraggingPanel] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [osType, setOsType] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<Agent>(AGENTS[0]);

  useEffect(() => {
    setPosition({
      x: window.innerWidth - 400,
      y: window.innerHeight / 4,
    });
  }, []);

  const setupEventSource = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const endTime = new Date();
    endTime.setMinutes(endTime.getMinutes() - 2);
    const startTime = new Date();
    startTime.setHours(0, 1, 0, 0);
    const url = `http://localhost:3030/stream/frames?start_time=${startTime.toISOString()}&end_time=${endTime.toISOString()}&order=descending`;

    setLoadedTimeRange({
      start: startTime,
      end: endTime,
    });

    console.log("starting stream:", url);

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data === "keep-alive-text") return;

        if (data.timestamp && data.devices) {
          setFrames((prev) => {
            const exists = prev.some((f) => f.timestamp === data.timestamp);
            if (exists) return prev;

            // ! HACK: Add new frame and sort in descending order
            const newFrames = [...prev, data].sort((a, b) => {
              return (
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime()
              );
            });

            return newFrames;
          });

          setCurrentFrame((prev) => prev || data.devices[0]);
          setIsLoading(false);
        }
      } catch (error) {
        console.error("failed to parse frame data:", error);
      }
    };

    eventSource.onerror = (error) => {
      if (eventSource.readyState === EventSource.CLOSED) {
        console.log("stream ended (expected behavior)", error);
        setIsLoading(false);
        return;
      }

      console.error("eventsource error:", error);
      setError("connection lost. retrying...");

      eventSource.close();
    };

    eventSource.onopen = () => {
      console.log("eventsource connection opened");
      setError(null);
      retryCount.current = 0;
    };
  };

  const getLoadedTimeRangeStyles = () => {
    if (!loadedTimeRange || frames.length === 0)
      return { left: "0%", right: "100%" };

    // Find the earliest frame timestamp
    const firstFrame = [...frames].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )[0];
    const earliestTime = new Date(firstFrame.timestamp);

    // Create local date objects for today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Convert UTC loadedTimeRange to local time
    const localStart = new Date(earliestTime);
    const localEnd = new Date(loadedTimeRange.end);

    const totalMs = endOfDay.getTime() - startOfDay.getTime();
    const startPercent =
      ((localStart.getTime() - startOfDay.getTime()) / totalMs) * 100;
    const endPercent =
      ((localEnd.getTime() - startOfDay.getTime()) / totalMs) * 100;

    // Temporarily return empty values to disable grey areas
    return {
      right: "0%",
      left: "0%",
    };

    // Original code commented out:
    // return {
    //   right: `${Math.max(0, Math.min(100, startPercent))}%`,  // Grey before data starts
    //   left: `${Math.max(0, Math.min(100, 100 - endPercent))}%`,  // Grey after data ends
    // };
  };

  useEffect(() => {
    setupEventSource();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setOsType(platform());
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (selectionRange) {
          handleAskAI();
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (isAiPanelExpanded && aiInput.trim()) {
          handleAiSubmit(e as unknown as React.FormEvent);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectionRange, isAiPanelExpanded, aiInput]);

  const handleScroll = (e: React.WheelEvent<HTMLDivElement>) => {
    const isWithinAiPanel = aiPanelRef.current?.contains(e.target as Node);
    if (isWithinAiPanel) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const scrollSensitivity = 1;
    const delta = -Math.sign(e.deltaY) / scrollSensitivity;

    const newIndex = Math.min(
      Math.max(
        0,
        currentIndex + (delta > 0 ? Math.ceil(delta) : Math.floor(delta))
      ),
      frames.length - 1
    );

    if (newIndex !== currentIndex) {
      setCurrentIndex(newIndex);
      setCurrentFrame(frames[newIndex].devices[0]);
    }
  };

  const getCurrentTimePercentage = () => {
    if (!currentFrame) return 0;

    const frameTime = new Date(
      currentFrame.metadata.timestamp || frames[currentIndex].timestamp
    );
    const startOfDay = new Date(frameTime);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(frameTime);
    endOfDay.setHours(23, 59, 59, 999);

    const totalDayMilliseconds = endOfDay.getTime() - startOfDay.getTime();
    const currentMilliseconds = frameTime.getTime() - startOfDay.getTime();

    return (currentMilliseconds / totalDayMilliseconds) * 100;
  };

  const handleTimelineMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = (clickX / rect.width) * 100;

    // Clamp percentage between 0 and 100
    const clampedPercentage = Math.max(0, Math.min(100, percentage));

    setIsDragging(true);
    setDragStart(clampedPercentage);

    const totalMinutesInDay = 24 * 60;
    const minutesFromMidnight = (clampedPercentage / 100) * totalMinutesInDay;
    const hours = Math.floor(minutesFromMidnight / 60);
    const minutes = Math.floor(minutesFromMidnight % 60);

    const localDate = new Date();
    localDate.setHours(hours, minutes, 0, 0);

    const utcDate = new Date(
      Date.UTC(
        localDate.getUTCFullYear(),
        localDate.getUTCMonth(),
        localDate.getUTCDate(),
        localDate.getUTCHours(),
        localDate.getUTCMinutes(),
        0,
        0
      )
    );

    setSelectionRange({
      start: utcDate,
      end: utcDate,
    });
  };

  const handleTimelineMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || dragStart === null) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const moveX = e.clientX - rect.left;
    const percentage = (moveX / rect.width) * 100;

    // Clamp percentage between 0 and 100
    const clampedPercentage = Math.max(0, Math.min(100, percentage));

    const totalMinutesInDay = 24 * 60;
    const startMinutes =
      (Math.min(dragStart, clampedPercentage) / 100) * totalMinutesInDay;
    const endMinutes =
      (Math.max(dragStart, clampedPercentage) / 100) * totalMinutesInDay;

    const startLocal = new Date();
    startLocal.setHours(
      Math.floor(startMinutes / 60),
      Math.floor(startMinutes % 60),
      0,
      0
    );

    const endLocal = new Date();
    endLocal.setHours(
      Math.floor(endMinutes / 60),
      Math.floor(endMinutes % 60),
      0,
      0
    );

    const utcStartDate = new Date(
      Date.UTC(
        startLocal.getUTCFullYear(),
        startLocal.getUTCMonth(),
        startLocal.getUTCDate(),
        startLocal.getUTCHours(),
        startLocal.getUTCMinutes(),
        0,
        0
      )
    );

    const utcEndDate = new Date(
      Date.UTC(
        endLocal.getUTCFullYear(),
        endLocal.getUTCMonth(),
        endLocal.getUTCDate(),
        endLocal.getUTCHours(),
        endLocal.getUTCMinutes(),
        0,
        0
      )
    );

    setSelectionRange({
      start: utcStartDate,
      end: utcEndDate,
    });
  };

  const handleTimelineMouseUp = () => {
    setIsDragging(false);
  };

  const handleAskAI = () => {
    if (isAiPanelExpanded) {
      setChatMessages([]);
      setIsAiPanelExpanded(false);
      setAiInput("");
    } else {
      setChatMessages([]);
      setIsAiPanelExpanded(true);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  };

  const handleAiSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiInput.trim() || !selectionRange) return;

    const relevantFrames = frames.filter((frame) => {
      const frameTime = new Date(frame.timestamp);
      return (
        frameTime >= selectionRange.start && frameTime <= selectionRange.end
      );
    });

    const contextData = selectedAgent.dataSelector(relevantFrames);

    const userMessage = {
      id: generateId(),
      role: "user" as const,
      content: aiInput,
    };
    setChatMessages((prev) => [...prev, userMessage]);
    setAiInput("");
    setIsAiLoading(true);

    try {
      const openai = new OpenAI({
        apiKey: settings.openaiApiKey,
        baseURL: settings.aiUrl,
        dangerouslyAllowBrowser: true,
      });

      const messages = [
        {
          role: "system" as const,
          content: `You are a helpful assistant specialized as a "${
            selectedAgent.name
          }" analyzing screen & mic recordings.
            Rules:
            - Current time (JavaScript Date.prototype.toString): ${new Date().toString()}
            - User timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
            - User timezone offset: ${new Date().getTimezoneOffset()}
            - All timestamps in the context data are in UTC
            - Convert timestamps to local time for human-readable responses
            - Never output UTC time unless explicitly asked
            - Focus on ${selectedAgent.description}
            `,
        },
        ...chatMessages,
        {
          role: "user" as const,
          content: `Context data: ${JSON.stringify(contextData)}
          
          ${aiInput}`,
        },
      ];

      console.log(
        "messages",
        messages.findLast((m) => m.role === "user")?.content
      );

      abortControllerRef.current = new AbortController();
      setIsStreaming(true);

      const stream = await openai.chat.completions.create(
        {
          model: settings.aiModel,
          messages: messages as ChatCompletionMessageParam[],
          stream: true,
        },
        {
          signal: abortControllerRef.current.signal,
        }
      );

      let fullResponse = "";
      setChatMessages((prev) => [
        ...prev,
        { id: generateId(), role: "assistant", content: "" },
      ]);

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        fullResponse += content;
        setChatMessages((prev) => [
          ...prev.slice(0, -1),
          { id: generateId(), role: "assistant", content: fullResponse },
        ]);
      }
    } catch (error: any) {
      console.error("Error generating AI response:", error);
      toast({
        title: "Error",
        description: "Failed to generate AI response. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAiLoading(false);
      setIsStreaming(false);
    }
  };

  useEffect(() => {
    const preventScroll = (e: WheelEvent) => {
      const isWithinAiPanel = aiPanelRef.current?.contains(e.target as Node);
      if (!isWithinAiPanel) {
        e.preventDefault();
      }
    };

    document.addEventListener("wheel", preventScroll, { passive: false });
    return () => document.removeEventListener("wheel", preventScroll);
  }, []);

  const handlePanelMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setIsDraggingPanel(true);
      setDragOffset({
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      });
    }
  };

  const handlePanelMouseMove = (e: React.MouseEvent) => {
    if (isDraggingPanel) {
      setPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    }
  };

  const handlePanelMouseUp = () => {
    setIsDraggingPanel(false);
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDraggingPanel) {
        setPosition({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y,
        });
      }
    };

    const handleGlobalMouseUp = () => {
      setIsDraggingPanel(false);
    };

    if (isDraggingPanel) {
      document.addEventListener("mousemove", handleGlobalMouseMove);
      document.addEventListener("mouseup", handleGlobalMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleGlobalMouseMove);
      document.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [isDraggingPanel, dragOffset]);

  const handleRefresh = () => {
    setFrames([]);
    setCurrentFrame(null);
    setCurrentIndex(0);
    setIsLoading(true);
    setupEventSource();
  };

  return (
    <div
      className="fixed inset-0 flex flex-col bg-black text-white overflow-hidden font-['Press_Start_2P'] relative"
      onWheel={(e) => {
        const isWithinAiPanel = aiPanelRef.current?.contains(e.target as Node);
        if (!isWithinAiPanel) {
          handleScroll(e);
        }
      }}
      style={{
        height: "100vh",
        overscrollBehavior: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        MozUserSelect: "none",
        msUserSelect: "none",
      }}
    >
      <button
        onClick={handleRefresh}
        className="absolute top-4 right-4 p-2 text-[#0f0] hover:text-[#0f0]/70 bg-black/50 rounded border border-[#0f0]/20 hover:border-[#0f0]/50 transition-colors z-50"
      >
        <RotateCcw className="h-4 w-4" />
      </button>

      <div
        className="fixed inset-0 pointer-events-none z-50"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 2px)",
        }}
      />

      <div className="flex-1 relative min-h-0">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-black/90 p-5 border-4 border-[#333] shadow-2xl text-center">
              <p>loading frames...</p>
              <div className="animate-blink inline-block w-2 h-2 bg-white ml-1" />
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-500">
            <p>{error}</p>
          </div>
        )}
        {currentFrame && (
          <>
            <div className="w-4/5 mx-auto mt-4 mb-4 text-center select-none">
              <div className="inline-block bg-black/50 p-2 rounded shadow-lg backdrop-blur-sm border border-[#333] text-[#888] text-xs tracking-wider">
                <div className="flex items-center gap-4">
                  <div>device: {currentFrame.device_id}</div>
                  <div>app: {currentFrame.metadata.app_name || "n/a"}</div>
                  <div>
                    window: {currentFrame.metadata.window_name || "n/a"}
                  </div>
                </div>
              </div>
            </div>
            <img
              src={`data:image/png;base64,${currentFrame.frame}`}
              className="absolute inset-0 w-4/5 h-auto max-h-[75vh] object-contain mx-auto mt-12"
              alt="Current frame"
            />
          </>
        )}
      </div>

      <div className="w-4/5 mx-auto my-8 relative select-none">
        <div
          className="h-[60px] bg-[#111] border-4 border-[#444] shadow-[0_0_16px_rgba(0,0,0,0.8),inset_0_0_8px_rgba(255,255,255,0.1)] cursor-crosshair relative"
          onMouseDown={handleTimelineMouseDown}
          onMouseMove={handleTimelineMouseMove}
          onMouseUp={handleTimelineMouseUp}
          onMouseLeave={handleTimelineMouseUp}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              ...getLoadedTimeRangeStyles(),
              background:
                "linear-gradient(to right, rgba(255,255,255,0.8), rgba(255,255,255,0.2))",
            }}
          />

          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, rgba(0,255,0,0.1) 1px, transparent 1px)",
              backgroundSize: "10% 100%",
            }}
          />

          <div
            className="absolute top-0 h-full w-1 bg-[#0f0] shadow-[0_0_12px_#0f0] opacity-80 z-10"
            style={{
              left: `${getCurrentTimePercentage()}%`,
            }}
          />

          {selectionRange && (
            <div
              className="absolute top-0 h-full bg-[#0f0] opacity-20"
              style={{
                left: `${
                  (new Date(selectionRange.start).getHours() * 3600 +
                    new Date(selectionRange.start).getMinutes() * 60) /
                  864
                }%`,
                width: `${
                  ((selectionRange.end.getTime() -
                    selectionRange.start.getTime()) /
                    (24 * 3600 * 1000)) *
                  100
                }%`,
              }}
            />
          )}
        </div>

        {selectionRange && (
          <div
            ref={aiPanelRef}
            onMouseEnter={() => setIsHoveringAiPanel(true)}
            onMouseLeave={() => setIsHoveringAiPanel(false)}
            style={{
              position: "fixed",
              left: position.x,
              top: position.y,
              cursor: isDraggingPanel ? "grabbing" : "grab",
            }}
            className={`w-96 bg-black/90 border-2 border-[#0f0] shadow-[0_0_20px_rgba(0,255,0,0.3)] rounded transition-colors duration-300 ease-in-out z-[100] ${
              isAiPanelExpanded ? "h-[70vh]" : "h-auto"
            }`}
          >
            <div
              className="p-2 border-b border-[#0f0]/20 select-none flex justify-between items-center group"
              onMouseDown={handlePanelMouseDown}
              onMouseMove={handlePanelMouseMove}
              onMouseUp={handlePanelMouseUp}
              onMouseLeave={handlePanelMouseUp}
            >
              <div className="flex items-center gap-2 flex-1 cursor-grab active:cursor-grabbing">
                <GripHorizontal className="w-4 h-4 text-[#0f0]/50 group-hover:text-[#0f0]" />
                <div className="text-[#0f0] text-xs">
                  {new Date(
                    selectionRange.start.getTime()
                  ).toLocaleTimeString()}{" "}
                  -{" "}
                  {new Date(selectionRange.end.getTime()).toLocaleTimeString()}
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectionRange(null);
                  setIsAiPanelExpanded(false);
                  setChatMessages([]);
                  setAiInput("");
                }}
                className="text-[#0f0] hover:text-[#0f0]/70 ml-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4">
              {!isAiPanelExpanded && (
                <button
                  className="px-3 py-1 bg-[#0f0]/20 hover:bg-[#0f0]/30 border border-[#0f0] text-[#0f0] text-xs rounded flex items-center gap-2"
                  onClick={() => {
                    setIsAiPanelExpanded(true);
                    setTimeout(() => {
                      inputRef.current?.focus();
                    }, 100);
                  }}
                >
                  <span>ask ai</span>
                  <span className="text-[#0f0]/50 text-[10px]">
                    {osType === "macos" ? "⌘K" : "Ctrl+K"}
                  </span>
                </button>
              )}
            </div>

            {isAiPanelExpanded && (
              <div className="flex flex-col h-[calc(100%-100px)]">
                <div
                  className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0 hover:cursor-auto text-[#eee] font-mono text-sm leading-relaxed"
                  style={{
                    WebkitUserSelect: "text",
                    userSelect: "text",
                    MozUserSelect: "text",
                    msUserSelect: "text",
                    overscrollBehavior: "contain",
                    textShadow: "0 0 1px rgba(255, 255, 255, 0.5)",
                    letterSpacing: "0.02em",
                  }}
                >
                  {chatMessages.map((msg, index) => (
                    <ChatMessage key={index} message={msg} />
                  ))}
                  {isAiLoading && (
                    <div className="flex justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-[#0f0]" />
                    </div>
                  )}
                </div>

                <form
                  onSubmit={handleAiSubmit}
                  className="p-4 border-t border-[#0f0]/20"
                  style={{
                    WebkitUserSelect: "text",
                    userSelect: "text",
                    MozUserSelect: "text",
                    msUserSelect: "text",
                  }}
                >
                  <div className="flex flex-col gap-2">
                    <select
                      value={selectedAgent.id}
                      onChange={(e) => setSelectedAgent(AGENTS.find(a => a.id === e.target.value) || AGENTS[0])}
                      className="w-full bg-black/50 border border-[#0f0] text-[#0f0] rounded px-2 py-1 text-xs"
                    >
                      {AGENTS.map((agent) => (
                        <option key={agent.id} value={agent.id} className="bg-black">
                          {agent.name} - {agent.description}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <Input
                        ref={inputRef}
                        type="text"
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        placeholder="ask about this time range..."
                        className="flex-1 bg-black/50 border-[#0f0] text-[#0f0] placeholder-[#0f0]/50"
                        disabled={isAiLoading}
                      />
                      <Button
                        type="submit"
                        disabled={isAiLoading}
                        className="bg-[#0f0]/20 hover:bg-[#0f0]/30 border border-[#0f0] text-[#0f0] group relative"
                      >
                        {isStreaming ? (
                          <Square className="h-4 w-4" />
                        ) : (
                          <>
                            <Send className="h-4 w-4" />
                            <span className="absolute -top-8 right-0 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity bg-black/90 px-2 py-1 rounded whitespace-nowrap">
                              {osType === "macos" ? "⌘↵" : "Ctrl+↵"}
                            </span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        <div className="relative mt-1 px-2 text-[10px] text-[#0f0] shadow-[0_0_8px_#0f0] select-none">
          {Array(7)
            .fill(0)
            .map((_, i) => {
              const hour = (i * 4) % 24;
              const date = new Date();
              date.setHours(hour, 0, 0, 0);
              return (
                <div
                  key={i}
                  className="absolute transform -translate-x-1/2"
                  style={{ left: `${(i * 100) / 6}%` }}
                >
                  {date.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              );
            })}
        </div>
      </div>

      <div className="fixed left-12 top-1/2 -translate-y-1/2 font-['Press_Start_2P'] text-xs text-[#0f0] animate-pulse select-none">
        <div className="flex flex-col items-center gap-1">
          <span>▲</span>
          <span className="tracking-wider">scroll</span>
          <span>▼</span>
        </div>
      </div>
    </div>
  );
}
