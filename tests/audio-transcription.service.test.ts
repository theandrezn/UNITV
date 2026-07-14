import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AudioTranscriptionService } from "@/services/audio/audio-transcription.service";

describe("AudioTranscriptionService", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://unitv-test.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("transcribes a WhatsApp Opus audio in Portuguese with the economy model", async () => {
    const evolutionService = {
      getMediaBase64: vi.fn(async () => ({
        base64: Buffer.from("OggS-audio-bytes").toString("base64"),
        mimeType: "audio/ogg; codecs=opus",
        fileName: "voice.ogg"
      }))
    };
    const create = vi.fn(async () => ({
      text: "  Quero   o plano mensal.  ",
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 }
    }));
    const service = new AudioTranscriptionService(
      evolutionService as never,
      { audio: { transcriptions: { create } } } as never,
      { enabled: true, model: "gpt-4o-mini-transcribe", maxBytes: 1024, maxCharacters: 2_000 }
    );

    const result = await service.transcribeWhatsAppAudio({
      externalMessageId: "audio-message-id",
      conversationId: null,
      declaredMimeType: "audio/ogg; codecs=opus"
    });

    expect(evolutionService.getMediaBase64).toHaveBeenCalledWith({ externalMessageId: "audio-message-id" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini-transcribe",
        language: "pt",
        response_format: "json",
        temperature: 0,
        prompt: expect.stringContaining("UNITV"),
        file: expect.objectContaining({ name: "voice.ogg", type: "audio/ogg" })
      }),
      { timeout: 45_000, maxRetries: 1 }
    );
    expect(result).toMatchObject({
      text: "Quero o plano mensal.",
      model: "gpt-4o-mini-transcribe",
      mimeType: "audio/ogg",
      truncated: false
    });
  });

  it("blocks oversized audio before spending an OpenAI transcription call", async () => {
    const create = vi.fn();
    const service = new AudioTranscriptionService(
      { getMediaBase64: vi.fn(async () => ({ base64: Buffer.alloc(100).toString("base64"), mimeType: "audio/ogg" })) } as never,
      { audio: { transcriptions: { create } } } as never,
      { enabled: true, model: "gpt-4o-mini-transcribe", maxBytes: 32, maxCharacters: 2_000 }
    );

    await expect(service.transcribeWhatsAppAudio({ externalMessageId: "large-audio" }))
      .rejects.toMatchObject({ code: "audio_too_large" });
    expect(create).not.toHaveBeenCalled();
  });

  it("treats silence as a transcription failure instead of inventing customer text", async () => {
    const service = new AudioTranscriptionService(
      { getMediaBase64: vi.fn(async () => ({ base64: Buffer.from("OggS-silence").toString("base64"), mimeType: "audio/ogg" })) } as never,
      { audio: { transcriptions: { create: vi.fn(async () => ({ text: "", usage: {} })) } } } as never,
      { enabled: true, model: "gpt-4o-mini-transcribe", maxBytes: 1024, maxCharacters: 2_000 }
    );

    await expect(service.transcribeWhatsAppAudio({ externalMessageId: "silent-audio" }))
      .rejects.toMatchObject({ code: "audio_no_speech" });
  });
});
