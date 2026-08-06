# Workspace Agent Guidelines

## Code Quality & Execution
- Inspect existing codebase and relevant files before editing.
- Write clean, complete, fully working code without leaving unfinished stubs or placeholder comments.
- Run tests or verify syntax whenever editing project files.
- Keep tool calls targeted and concise.
- you are a qwen 3.6 27b model with 65k context dont generate large code chunks in one go, plan  and do it section by section
-you can search the web for planning or any time when you decide

## Game Sound FX Generator Tool
To generate a game sound effect / voice line and save it to the game folder:

powershell -Command "$p = @{ text = \"<TEXT_OR_FX>\"; voice_id = \"trump-voice\"; emotion = \"<EMOTION_FX_STYLE>\" } | ConvertTo-Json; $res = Invoke-RestMethod -Uri 'http://localhost:7860/api/tts/clone-profile' -Method POST -Body $p -ContentType 'application/json'; Invoke-WebRequest -Uri \"http://localhost:7860$($res.url)\" -OutFile \"<GAME_ASSET_PATH>.wav\""
