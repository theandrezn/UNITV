import "server-only";
import { toFile } from "openai";
import { createOpenAIClient } from "@/lib/openai/client";
import { getAudioTranscriptionConfig } from "@/lib/env";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";

type AudioTranscriptionConfig = ReturnType<typeof getAudioTranscriptionConfig>;

type TranscribeWhatsAppAudioInput = {
  externalMessageId: string;
  conversationId?: string | null;
  declaredMimeType?: string | null;
  declaredFileName?: string | null;
};

export type AudioTranscriptionResult = {
  text: string;
  model: string;
  bytes: number;
  mimeType: string;
  truncated: boolean;
};

export class AudioTranscriptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

const PORTUGUESE_UNITV_PROMPT =
  "Conversa comercial e de suporte em portugues brasileiro. Termos comuns: UNITV, Pix, TV Box, Android TV, Google TV, Fire Stick e Downloader.";

export class AudioTranscriptionService {
  constructor(
    private readonly evolutionService = new EvolutionService(),
    private readonly openAIClient?: ReturnType<typeof createOpenAIClient>,
    private readonly configOverride?: Partial<AudioTranscriptionConfig>
  ) {}

  async transcribeWhatsAppAudio(input: TranscribeWhatsAppAudioInput): Promise<AudioTranscriptionResult> {
    const config = { ...getAudioTranscriptionConfig(), ...(this.configOverride || {}) };
    if (!config.enabled) {
      throw new AudioTranscriptionError("audio_transcription_disabled", "Audio transcription is disabled.");
    }

    const media = await this.evolutionService.getMediaBase64({ externalMessageId: input.externalMessageId });
    const encoded = stripDataUrl(media.base64);
    const estimatedBytes = Math.floor(encoded.length * 0.75);
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new AudioTranscriptionError("audio_media_invalid", "Audio media is not valid base64.");
    }
    if (estimatedBytes > config.maxBytes) {
      throw new AudioTranscriptionError("audio_too_large", "Audio exceeds the configured transcription limit.");
    }

    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length) {
      throw new AudioTranscriptionError("audio_empty", "Audio media is empty.");
    }
    if (buffer.length > config.maxBytes) {
      throw new AudioTranscriptionError("audio_too_large", "Audio exceeds the configured transcription limit.");
    }

    const mimeType = normalizeAudioMimeType(media.mimeType || input.declaredMimeType);
    const fileName = buildAudioFileName(media.fileName || input.declaredFileName, mimeType);
    const file = await toFile(buffer, fileName, { type: mimeType });
    const response = await executeObservedOpenAICall(
      { callType: "audio_transcription", model: config.model, conversationId: input.conversationId || null },
      () => (this.openAIClient || createOpenAIClient()).audio.transcriptions.create(
        {
          file,
          model: config.model,
          language: "pt",
          prompt: PORTUGUESE_UNITV_PROMPT,
          response_format: "json",
          temperature: 0
        },
        { timeout: 45_000, maxRetries: 1 }
      )
    );
    if (!response) {
      throw new AudioTranscriptionError("audio_transcription_unavailable", "Audio transcription is temporarily unavailable.");
    }

    const fullText = String(response.text || "").replace(/\s+/g, " ").trim();
    if (!fullText) {
      throw new AudioTranscriptionError("audio_no_speech", "No speech was detected in the audio.");
    }

    return {
      text: fullText.slice(0, config.maxCharacters),
      model: config.model,
      bytes: buffer.length,
      mimeType,
      truncated: fullText.length > config.maxCharacters
    };
  }
}

export function readAudioTranscriptionErrorCode(error: unknown) {
  return error instanceof AudioTranscriptionError ? error.code : "audio_transcription_failed";
}

function stripDataUrl(value: string) {
  return String(value || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
}

function normalizeAudioMimeType(value: string | null | undefined) {
  const normalized = String(value || "audio/ogg").toLowerCase().split(";")[0].trim();
  if (normalized === "audio/opus") return "audio/ogg";
  return normalized.startsWith("audio/") || normalized === "video/mp4" ? normalized : "audio/ogg";
}

function buildAudioFileName(value: string | null | undefined, mimeType: string) {
  const extension = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("mpeg") || mimeType.includes("mp3")
        ? "mp3"
        : mimeType.includes("mp4") || mimeType.includes("m4a")
          ? "m4a"
          : mimeType.includes("flac")
            ? "flac"
            : "ogg";
  const safeBase = String(value || "whatsapp-audio").replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
  return `${safeBase || "whatsapp-audio"}.${extension}`;
}
