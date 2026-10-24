# Kids-safe build

This fork of [intel/AI-Playground](https://github.com/intel/AI-Playground) adds content filtering for children. Every filter fails closed: if a check cannot run, the request is blocked.

## What is filtered

| Path | Check |
| --- | --- |
| Chat message the child types | Word list (PL/EN), then Qwen3Guard-Gen-4B prompt moderation, before any model runs |
| Chat reply | Held until complete, judged by Qwen3Guard in the context of the question, then shown or replaced. Reasoning ("thinking") text is never shown |
| Image prompt (image panel and chat image tool) | Same prompt check, before ComfyUI starts |
| Generated image | `SafetyChecker` node (vit-base-nsfw-detector) on every image in the batch, threshold locked at 0.1. Includes the OpenVINO variants, Colorize, Change Face and Upscale |
| Live previews | Never shown (they are unfiltered intermediate frames) |
| Agent mode (Agent, Game Agent, Quick Coder) | Turned off: those turns stream outside the chat guard |

Blocked requests get the reply "Nie mogę w tym pomóc. Zapytaj o coś innego. / I can't help with that. Try asking about something else." Both "Unsafe" and "Controversial" verdicts block.

## Requirements

- The **Llama.cpp** backend must be installed. The guard runs as its own llama-server on loopback, on the device selected for Llama.cpp.
- On first use the app asks to download the guard model `mradermacher/Qwen3Guard-Gen-4B-GGUF` (Q4_K_M, about 2.7 GB) through the normal download dialog. Until it is downloaded, chat and image generation are blocked.
- Measured on an Intel Core Ultra 5 135U iGPU: about 0.7 s per prompt check, under 1 s for a typical reply, about 8 s for a very long reply (3,200 characters). Replies are held until checked, so that time is added to every answer.
- Image presets download `AdamCodd/vit-base-nsfw-detector` as before.

## Code

- `WebUI/electron/safety/kidsGuard.ts` – guard client, word list, reply holding.
- `WebUI/electron/adapters/backends/llamaCppBackendService.ts` – `ensureGuardServer` (ignores user startup parameters).
- `WebUI/electron/chat/turnEngine.ts`, `WebUI/electron/artifact/runner.ts` – where prompts and replies are checked.
- `comfyui-deps/custom_nodes/SafetyChecker/nodes.py` and `modes/base/` presets – image output filter.

## Limits

No filter is perfect. On a 50-prompt Polish test set the 4B guard plus the word list missed 0 of 30 harmful prompts and blocked 1 of 20 harmless ones (a family in swimsuits at the pool); the set is small, so treat that as indicative. Short Polish slang is the weakest area, which is what the word list is for. Video presets and text-to-speech are not filtered. Use this together with a separate non-admin account for the child and OS parental controls: a child with admin rights can edit presets, the ComfyUI workflows or the app itself.
