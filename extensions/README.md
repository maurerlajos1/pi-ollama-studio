# Studio-owned Pi extensions

## Qwen3-TTS

`pi-ollama-studio-tts.ts` is loaded explicitly by Studio when it starts Pi. It registers the `tts_speak` tool and calls only Studio's loopback HTTP API.

The tool requests a short-lived same-origin audio artifact. Pi receives only the artifact metadata and a short text result; generated audio bytes are not inserted into model context. Studio renders the artifact as an audio player in the completed tool card.

Environment variables are supplied by Studio:

- `PI_OLLAMA_STUDIO_URL`: active loopback Studio server URL.
- `PI_OLLAMA_STUDIO_TTS_URL`: optional Qwen3-TTS URL override; defaults to `http://127.0.0.1:7860`.

Harness tool allowlists still apply. A bounded harness must include `tts_speak` explicitly if it should be available; Pi-default harnesses inherit enabled extension tools.

