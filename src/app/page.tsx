"use client";
import { useState, useRef, useEffect } from "react";

interface SubtitleChunk {
  text: string;
  start: number;
  end: number;
}

const STEPS = [
  "Generating voice",
  "Creating video",
  "Done",
] as const;

function getStepIndex(status: string): number {
  if (status.startsWith("Generating")) return 0;
  if (status.startsWith("Creating")) return 1;
  if (status === "Done!") return 2;
  return -1;
}

export default function VoiceGeneratorPage() {
  const [text, setText] = useState("");
  const [firstName, setFirstName] = useState("");
  const [namePronunciation, setNamePronunciation] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [status, setStatus] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFormat, setVideoFormat] = useState<"mp4" | "webm">("mp4");
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSubtitles, setIncludeSubtitles] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);

  const currentStep = getStepIndex(status);
  const charCount = text.length;
  const charWarning = charCount > 500;

  // Cleanup blob URLs on change and unmount
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
    };
  }, [previewAudioUrl]);

  const handlePreviewAudio = async () => {
    if (!text.trim()) return;
    setPreviewing(true);
    setError(null);
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      setPreviewAudioUrl(null);
    }

    try {
      const res = await fetch("/api/generate-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          first_name: firstName,
          name_pronunciation: namePronunciation || "",
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Voice generation failed");
      }

      const data = await res.json();
      const audioBytes = Uint8Array.from(atob(data.audio), (c) =>
        c.charCodeAt(0)
      );
      const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(audioBlob);
      setPreviewAudioUrl(url);

      // Auto-play the preview (catch rejection if browser blocks autoplay)
      setTimeout(() => {
        previewAudioRef.current?.play().catch(() => {
          // Autoplay blocked — user can click the audio controls manually
        });
      }, 100);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
    } finally {
      setPreviewing(false);
    }
  };

  const handleGenerate = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setVideoUrl(null);
    setStatus("Generating voice...");

    try {
      const res = await fetch("/api/generate-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          first_name: firstName,
          name_pronunciation: namePronunciation || "",
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Voice generation failed");
      }

      const data = await res.json();
      setStatus("Creating video...");

      const audioBytes = Uint8Array.from(atob(data.audio), (c) =>
        c.charCodeAt(0)
      );
      const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });

      const { blob: finalBlob, format } = await createVideo(
        audioBlob,
        data.subtitles,
        includeSubtitles
      );

      const url = URL.createObjectURL(finalBlob);
      setVideoUrl(url);
      setVideoFormat(format);
      setStatus("Done!");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  const createVideo = async (
    audioBlob: Blob,
    subtitles: SubtitleChunk[],
    showSubs: boolean
  ): Promise<{ blob: Blob; format: "mp4" | "webm" }> => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d")!;

    // Decode MP3 to full-quality PCM using Web Audio API
    const arrayBuffer = await audioBlob.arrayBuffer();
    // Use 48kHz — standard for video production, matches Opus/AAC encoder expectations
    // Avoids unnecessary resampling inside MediaRecorder which degrades quality
    const audioCtx = new AudioContext({ sampleRate: 48000 });

    // Ensure AudioContext is running (can be suspended after async calls)
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const audioDuration = audioBuffer.duration;

    // Deep-copy subtitles so we don't mutate the caller's array
    const subs = subtitles.map((s) => ({ ...s }));

    // Rescale subtitle timings to match actual audio duration
    if (subs.length > 0) {
      const lastSub = subs[subs.length - 1];
      const estimatedDuration = lastSub.end;
      if (estimatedDuration > 0 && audioDuration > 0) {
        const scale = audioDuration / estimatedDuration;
        for (const sub of subs) {
          sub.start *= scale;
          sub.end *= scale;
        }
      }
    }

    // Play decoded PCM through AudioBufferSourceNode → recording stream
    const sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;

    // Add a GainNode at unity (1.0) — this ensures the full dynamic range
    // of the decoded audio passes through without any clipping or compression
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;

    const dest = audioCtx.createMediaStreamDestination();
    sourceNode.connect(gainNode);
    gainNode.connect(dest);

    // Combine canvas video stream + audio stream
    const videoStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...videoStream.getTracks(),
      ...dest.stream.getTracks(),
    ]);

    // Pick best available format — prefer MP4 (native on modern Chrome)
    let mimeType = "";
    if (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E,mp4a.40.2")) {
      mimeType = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
    } else if (MediaRecorder.isTypeSupported("video/mp4")) {
      mimeType = "video/mp4";
    } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) {
      mimeType = "video/webm;codecs=vp9,opus";
    } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) {
      mimeType = "video/webm;codecs=vp8,opus";
    } else {
      mimeType = "video/webm";
    }

    const recorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
      // Max audio quality — 320kbps is CD-quality for AAC/Opus
      // This prevents MediaRecorder from compressing dynamics/enthusiasm
      audioBitsPerSecond: 320_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    return new Promise((resolve, reject) => {
      let stopped = false;
      let animFrameId = 0;

      const cleanup = () => {
        // Cancel any pending animation frame
        if (animFrameId) cancelAnimationFrame(animFrameId);
        // Stop all tracks (canvas + audio) to free resources
        combined.getTracks().forEach((t) => t.stop());
        // Close AudioContext
        audioCtx.close().catch(() => {});
      };

      const stopRecording = () => {
        if (stopped) return;
        stopped = true;
        // IMPORTANT: Stop the recorder FIRST while tracks are still alive
        // so it can finalize the codec container properly.
        // Track cleanup happens in onstop after the blob is built.
        if (recorder.state === "recording") {
          recorder.stop();
        } else {
          // Recorder already stopped (e.g. browser auto-stopped it) — clean up
          cleanup();
        }
      };

      recorder.onstop = () => {
        cleanup();
        const blob = new Blob(chunks, { type: mimeType });
        const format = mimeType.includes("mp4") ? "mp4" as const : "webm" as const;
        resolve({ blob, format });
      };

      recorder.onerror = () => {
        cleanup();
        reject(new Error("Video recording failed"));
      };

      // Safety timeout — cap at audioDuration + 5s (minimum 15s)
      const safetyMs = Math.max((audioDuration + 5) * 1000, 15_000);
      const safetyTimeout = setTimeout(() => {
        console.warn("Safety timeout reached, stopping recording");
        stopRecording();
      }, safetyMs);

      // Stop when audio buffer finishes playing
      sourceNode.onended = () => {
        // Tiny buffer (50ms) for final frame, then stop cleanly
        setTimeout(() => {
          clearTimeout(safetyTimeout);
          stopRecording();
        }, 50);
      };

      // Start recording — NO timeslice for clean single-chunk codec output
      recorder.start();

      // Track time on the AUDIO clock so subtitles are perfectly synced
      const audioStartTime = audioCtx.currentTime;
      sourceNode.start(0);

      const drawFrame = () => {
        if (stopped) return;

        // Use audio clock, not wall clock — prevents desync from latency/suspension
        const elapsed = audioCtx.currentTime - audioStartTime;

        // Hard-stop if past audio duration (prevents runaway frames)
        if (elapsed > audioDuration + 0.3) {
          clearTimeout(safetyTimeout);
          stopRecording();
          return;
        }

        // Pitch black background
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 1080, 1080);

        if (showSubs) {
          const currentSub = subs.find(
            (s) => elapsed >= s.start && elapsed < s.end
          );
          if (currentSub) {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            const maxWidth = 900;
            const words = currentSub.text.split(" ");
            const lines: string[] = [];
            let currentLine = "";

            ctx.font = "600 36px Arial, sans-serif";

            for (const word of words) {
              const test = currentLine ? currentLine + " " + word : word;
              if (ctx.measureText(test).width > maxWidth) {
                lines.push(currentLine);
                currentLine = word;
              } else {
                currentLine = test;
              }
            }
            lines.push(currentLine);

            const lineHeight = 48;
            const startY = 540 - (lines.length * lineHeight) / 2;

            lines.forEach((line, i) => {
              // Text shadow for readability
              ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
              ctx.font = "600 36px Arial, sans-serif";
              ctx.fillText(line, 542, startY + i * lineHeight + 2);
              // White text
              ctx.fillStyle = "#ffffff";
              ctx.fillText(line, 540, startY + i * lineHeight);
            });
          }
        }

        animFrameId = requestAnimationFrame(drawFrame);
      };

      drawFrame();
    });
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `voice-message-${firstName || "video"}-${Date.now()}.${videoFormat}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleReset = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
    setVideoUrl(null);
    setPreviewAudioUrl(null);
    setError(null);
    setStatus("");
  };

  return (
    <div className="min-h-screen">
      {/* Subtle grid background */}
      <div
        className="fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      <div className="relative mx-auto max-w-xl px-5 py-12 sm:py-16">
        {/* Header */}
        <header className="mb-10 flex flex-col items-center">
          <img
            src="/godscrew-logo.png"
            alt="God's Cleaning Crew"
            className="h-16 w-auto mb-4"
          />
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 mb-1">
            Voice Generator
          </h1>
          <p className="text-center text-sm text-zinc-500">
            Create personalized AI voice videos in seconds
          </p>
        </header>

        {/* Main form card */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur-sm shadow-xl shadow-black/20">
          {/* Prospect name */}
          <div className="p-5 pb-0">
            <label
              htmlFor="prospect-name"
              className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                />
              </svg>
              Prospect Name
            </label>
            <input
              id="prospect-name"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="e.g. John"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 transition-colors focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
            <div className="mt-2">
              <input
                type="text"
                value={namePronunciation}
                onChange={(e) => setNamePronunciation(e.target.value)}
                placeholder="Pronunciation hint (e.g. Ah-kash)"
                className="w-full rounded-lg border border-zinc-800/50 bg-zinc-950/30 px-3.5 py-2 text-xs text-zinc-400 placeholder-zinc-700 transition-colors focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
              />
              <p className="mt-1 text-[11px] text-zinc-600">
                Optional — type how the name sounds if the AI mispronounces it
              </p>
            </div>
          </div>

          {/* Divider */}
          <div className="mx-5 my-4 h-px bg-zinc-800/60" />

          {/* Message */}
          <div className="px-5">
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="message-text"
                className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                  />
                </svg>
                Message Script
              </label>
              <span
                className={`text-xs tabular-nums ${
                  charWarning ? "text-amber-400" : "text-zinc-600"
                }`}
              >
                {charCount}
              </span>
            </div>
            <textarea
              id="message-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder={`Hey {first_name}, I've been catching up with a few PMs across Toronto, and one thing that keeps coming up is the inflation and the increase in vendor prices. Is that something that resonates with you?`}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950/50 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder-zinc-600 transition-colors focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500/40 resize-none"
            />
            <p className="mt-1 text-[11px] text-zinc-600">
              Use{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
                {"{first_name}"}
              </code>{" "}
              to personalize the message
            </p>
          </div>

          {/* Divider */}
          <div className="mx-5 my-4 h-px bg-zinc-800/60" />

          {/* Options */}
          <div className="px-5 pb-5">
            <button
              type="button"
              onClick={() => setIncludeSubtitles(!includeSubtitles)}
              className="group flex w-full items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-950/30 px-3.5 py-3 transition-colors hover:border-zinc-700/60"
            >
              <div className="flex items-center gap-3">
                <svg
                  className="h-4 w-4 text-zinc-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 016 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5"
                  />
                </svg>
                <span className="text-sm text-zinc-300">
                  Burn subtitles into video
                </span>
              </div>
              <div
                className="toggle-track"
                data-checked={includeSubtitles}
                role="switch"
                aria-checked={includeSubtitles}
              />
            </button>
          </div>

          {/* Progress steps (shown while loading) */}
          {loading && (
            <div className="mx-5 mb-5">
              <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/50 p-4">
                <div className="flex items-center gap-3">
                  {STEPS.map((step, i) => (
                    <div key={step} className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition-all ${
                            i < currentStep
                              ? "bg-blue-500 text-white"
                              : i === currentStep
                                ? "bg-blue-500/20 text-blue-400 ring-2 ring-blue-500/40"
                                : "bg-zinc-800 text-zinc-600"
                          }`}
                        >
                          {i < currentStep ? (
                            <svg
                              className="h-3 w-3"
                              fill="none"
                              viewBox="0 0 24 24"
                              strokeWidth={3}
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M4.5 12.75l6 6 9-13.5"
                              />
                            </svg>
                          ) : (
                            i + 1
                          )}
                        </div>
                        <span
                          className={`hidden text-xs sm:block ${
                            i <= currentStep
                              ? "text-zinc-300"
                              : "text-zinc-600"
                          }`}
                        >
                          {step}
                        </span>
                      </div>
                      {i < STEPS.length - 1 && (
                        <div
                          className={`h-px w-4 sm:w-6 ${
                            i < currentStep ? "bg-blue-500" : "bg-zinc-800"
                          }`}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {/* Indeterminate progress bar */}
                <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div className="progress-bar h-full w-1/3 rounded-full bg-blue-500" />
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mx-5 mb-5">
              <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-950/20 p-3.5">
                <svg
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                  />
                </svg>
                <p className="text-sm leading-relaxed text-red-300/90">
                  {error}
                </p>
              </div>
            </div>
          )}

          {/* Audio preview */}
          {previewAudioUrl && (
            <div className="mx-5 mb-4">
              <div className="flex items-center gap-3 rounded-lg border border-zinc-800/60 bg-zinc-950/50 p-3">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-emerald-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                  />
                </svg>
                <audio
                  ref={previewAudioRef}
                  src={previewAudioUrl}
                  controls
                  className="h-8 w-full [&::-webkit-media-controls-panel]:bg-zinc-800"
                />
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                Name sounds wrong? Adjust the pronunciation hint above and preview again
              </p>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3 p-5 pt-0">
            {/* Preview Audio button */}
            <button
              onClick={handlePreviewAudio}
              disabled={loading || previewing || !text.trim()}
              className={`flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-all ${
                loading || previewing || !text.trim()
                  ? "cursor-not-allowed bg-zinc-800 text-zinc-600"
                  : "border border-zinc-700/60 text-zinc-300 hover:border-zinc-600 hover:text-zinc-200 active:scale-[0.98]"
              }`}
            >
              {previewing ? (
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                  />
                </svg>
              )}
              {previewing ? "..." : "Preview"}
            </button>

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={loading || previewing || !text.trim()}
              className={`group relative flex-1 overflow-hidden rounded-xl px-4 py-3 text-sm font-medium transition-all ${
                loading || previewing || !text.trim()
                  ? "cursor-not-allowed bg-zinc-800 text-zinc-600"
                  : "bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500 hover:shadow-blue-500/25 active:scale-[0.98]"
              }`}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2.5">
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Processing...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z"
                    />
                  </svg>
                  Generate Voice Message
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Video Preview */}
        {videoUrl && (
          <div className="mt-6 rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur-sm shadow-xl shadow-black/20 overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <h2 className="text-sm font-medium text-zinc-300">
                  Preview Ready
                </h2>
              </div>
              <span className="text-xs text-zinc-600">1080 x 1080</span>
            </div>

            <div className="bg-black/50 p-4">
              <div className="flex justify-center rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  className="max-h-[420px] w-auto rounded-lg"
                />
              </div>
            </div>

            <div className="flex gap-3 border-t border-zinc-800/60 p-4">
              <button
                onClick={handleDownload}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/15 transition-all hover:bg-emerald-500 active:scale-[0.98]"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                  />
                </svg>
                Download {videoFormat.toUpperCase()}
              </button>
              <button
                onClick={handleReset}
                className="flex items-center gap-2 rounded-xl border border-zinc-700/60 px-4 py-2.5 text-sm font-medium text-zinc-400 transition-all hover:border-zinc-600 hover:text-zinc-300 active:scale-[0.98]"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                  />
                </svg>
                New
              </button>
            </div>
          </div>
        )}

        {/* How it works — minimal stepper */}
        <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-zinc-600">
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-800/80 text-[10px] font-semibold text-zinc-500">
              1
            </span>
            Write
          </span>
          <svg className="h-3 w-3 text-zinc-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-800/80 text-[10px] font-semibold text-zinc-500">
              2
            </span>
            Generate
          </span>
          <svg className="h-3 w-3 text-zinc-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-800/80 text-[10px] font-semibold text-zinc-500">
              3
            </span>
            Download
          </span>
        </div>
      </div>
    </div>
  );
}
