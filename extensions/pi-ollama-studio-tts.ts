import { Type } from "typebox";

/**
 * Optional Pi extension for Qwen3-TTS through Studio's loopback proxy.
 *
 * Install/load this file explicitly in Pi; Studio never installs it globally.
 * PI_OLLAMA_STUDIO_URL points at Studio (default: http://127.0.0.1:4173).
 * PI_OLLAMA_STUDIO_TTS_URL points at the Qwen3-TTS service
 * (default: http://127.0.0.1:7860).
 */
export default function (pi) {
  const studioUrl = String(process.env.PI_OLLAMA_STUDIO_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
  const ttsUrl = String(process.env.PI_OLLAMA_STUDIO_TTS_URL || "http://127.0.0.1:7860").replace(/\/$/, "");

  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(studioUrl)) {
    throw new Error("PI_OLLAMA_STUDIO_URL must point to a loopback Studio server");
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(ttsUrl)) {
    throw new Error("PI_OLLAMA_STUDIO_TTS_URL must point to a loopback TTS server");
  }

  pi.registerTool({
    name: "tts_speak",
    label: "Speak text with Qwen3-TTS",
    description: "Generate speech from text through the local Studio Qwen3-TTS proxy. The generated audio is returned to Studio's agent tool pipeline; it is not uploaded or sent to a remote service.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to synthesize", minLength: 1 }),
      voice: Type.Optional(Type.String({ description: "Qwen3-TTS voice identifier", default: "default" })),
      format: Type.Optional(Type.Union([
        Type.Literal("wav"),
        Type.Literal("mp3"),
        Type.Literal("opus"),
        Type.Literal("aac"),
        Type.Literal("flac")
      ], { description: "Audio output format", default: "wav" }))
    }),
    async execute(_toolCallId, params) {
      const text = String(params?.text || "").trim();
      if (!text) throw new Error("tts_speak requires non-empty text");
      const voice = String(params?.voice || "default");
      const format = String(params?.format || "wav");
      let response;
      try {
        response = await fetch(`${studioUrl}/api/tts/generate-artifact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: ttsUrl, text, voice, response_format: format }),
          signal: AbortSignal.timeout(120000)
        });
      } catch (error) {
        throw new Error(`Studio TTS request failed: ${error?.message || error}`);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Studio TTS returned HTTP ${response.status}`);
      }
      const value = await response.json().catch(() => ({}));
      const artifact = value?.artifact;
      if (!artifact?.url || !String(artifact.url).startsWith('/api/tts/audio/')) {
        throw new Error('Studio TTS returned an invalid audio artifact');
      }
      return {
        content: [{ type: "text", text: `Generated ${format} speech (${artifact.bytes} bytes) with voice ${voice}. Studio has attached a playable audio result.` }],
        details: { ...artifact, audioUrl: artifact.url }
      };
    }
  });
}
