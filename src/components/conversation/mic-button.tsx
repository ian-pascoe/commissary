import { MicIcon, MicOffIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useChat } from "~/contexts/chat";
import { AIInputButton } from "../ui/kibo-ui/ai/input";
import { AudioWaves } from "./audio-waves";

export const MicButton = () => {
  const { setInput, setIsListening } = useChat((ctx) => ({
    setInput: ctx.setInput,
    setIsListening: ctx.setIsListening,
  }));

  const [recognition, setRecognition] = useState<any>(null);
  useEffect(() => {
    setIsListening(Boolean(recognition));
  }, [recognition, setIsListening]);

  const handleClick = useCallback(async () => {
    // If already recognizing, stop it
    if (recognition) {
      recognition.stop();
      setRecognition(null);
      return;
    }

    // Request microphone permission
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("Media devices not supported");
      return;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      console.error("Microphone permission denied:", error);
      return;
    }

    // Toggle speech recognition
    if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join("");
        setInput((prev) => prev + transcript);
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        setRecognition(null);
      };

      recognition.start();

      setRecognition(recognition);
    }
  }, [setInput, recognition]);

  return (
    <AIInputButton
      disabled={
        !("SpeechRecognition" in window) &&
        !("webkitSpeechRecognition" in window)
      }
      onClick={handleClick}
      className={`relative w-fit p-3 transition-all duration-200 ${
        recognition
          ? "bg-red-500 text-white shadow-md shadow-red-500/25 hover:bg-red-600"
          : ""
      }`}
    >
      <div className="flex items-center gap-1">
        {recognition ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
        {recognition && (
          <AudioWaves isActive={Boolean(recognition)} className="text-white" />
        )}
      </div>
    </AIInputButton>
  );
};
