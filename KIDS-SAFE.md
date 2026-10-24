# Kids-safe build

This fork of [intel/AI-Playground](https://github.com/intel/AI-Playground) adds content filtering for children. Every filter fails closed: if a check cannot run, the request is blocked.

## What is filtered

| Path | Check |
| --- | --- |
| Chat message the child types | Word list (PL/EN), then Qwen3Guard-Gen-0.6B prompt moderation, before any model runs |
| Chat reply | Held until complete, judged by Qwen3Guard in the context of the question, then shown or replaced. Reasoning ("thinking") text is never shown |
| Image prompt (image panel and chat image tool) | Same prompt check, before ComfyUI starts |
| Generated image | `SafetyChecker` node (vit-base-nsfw-detector) on every image in the batch, threshold locked at 0.1. Includes the OpenVINO variants, Colorize, Change Face and Upscale |
| Live previews | Never shown (they are unfiltered intermediate frames) |
| Agent mode (Agent, Game Agent, Quick Coder) | Turned off: those turns stream outside the chat guard |

Blocked requests get the reply "Nie mogę w tym pomóc. Zapytaj o coś innego. / I can't help with that. Try asking about something else." Both "Unsafe" and "Controversial" verdicts block.

## Requirements

- The **Llama.cpp** backend must be installed. The guard runs as its own llama-server on loopback, on the device selected for Llama.cpp.
- On first use the app asks to download the guard model `QuantFactory/Qwen3Guard-Gen-0.6B-GGUF` (Q8_0, about 800 MB) through the normal download dialog. Until it is downloaded, chat and image generation are blocked.
- Image presets download `AdamCodd/vit-base-nsfw-detector` as before.

## Code

- `WebUI/electron/safety/kidsGuard.ts` – guard client, word list, reply holding.
- `WebUI/electron/adapters/backends/llamaCppBackendService.ts` – `ensureGuardServer` (ignores user startup parameters).
- `WebUI/electron/chat/turnEngine.ts`, `WebUI/electron/artifact/runner.ts` – where prompts and replies are checked.
- `comfyui-deps/custom_nodes/SafetyChecker/nodes.py` and `modes/base/` presets – image output filter.

## Limits

No filter is perfect. Qwen3Guard 0.6B is weaker in Polish than in English (the word list covers the common gaps), and borderline but harmless requests (for example swimwear) are sometimes blocked. Video presets and text-to-speech are not filtered. Use this together with a separate non-admin account for the child and OS parental controls: a child with admin rights can edit presets, the ComfyUI workflows or the app itself.
