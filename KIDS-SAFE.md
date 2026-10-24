# Kids-safe build

This fork of [intel/AI-Playground](https://github.com/intel/AI-Playground) adds content filtering for children. Every filter fails closed: if a check cannot run, the request is blocked.

## What is filtered

| Path | Check |
| --- | --- |
| Chat message the child types | Word list (PL/EN), then Qwen3Guard-Gen-4B prompt moderation, before any model runs |
| Chat reply | Shown in pieces, each judged by Qwen3Guard (with the question and the end of the text already shown) before it appears. A blocked piece is never shown: the reply stops and the blocked message is added. Reasoning ("thinking") text is never shown |
| Image prompt (image panel and chat image tool) | Same prompt check, before ComfyUI starts |
| Generated image | `SafetyChecker` node (vit-base-nsfw-detector) on every image in the batch, threshold locked at 0.4 (strength 0.6). Includes the OpenVINO variants, Colorize, Change Face and Upscale |
| Live previews | Never shown (they are unfiltered intermediate frames) |
| Agent mode (Agent, Game Agent, Quick Coder) | Turned off: those turns stream outside the chat guard |

Blocked requests get the reply "Nie mogę w tym pomóc. Zapytaj o coś innego. / I can't help with that. Try asking about something else." Both "Unsafe" and "Controversial" verdicts block.

## Requirements

- The **Llama.cpp** backend must be installed. The guard runs as its own llama-server on loopback, never with the user's startup parameters.
- On first use the app asks, in one download dialog, for both guard models: `mradermacher/Qwen3Guard-Gen-4B-GGUF` (Q4_K_M, about 2.7 GB) and `QuantFactory/Qwen3Guard-Gen-0.6B-GGUF` (Q8_0, about 0.8 GB), so a fallback never downloads mid-session. Until at least one guard model is downloaded, chat and image generation are blocked.
- Measured on an Intel Core Ultra 5 135U iGPU with Qwen3.5-4B as the chat model: about 2 s per prompt check; the first part of a reply appears after about 20 s (3-4 s without the guard), and a 1,650-character answer is fully shown after about 77 s (about 55 s without the guard). The guard shares the GPU with the chat model, which slows generation by about 25%. Running the guard on the CPU instead was slower on this laptop.
- Image presets download `AdamCodd/vit-base-nsfw-detector` as before.

## Where the guard runs

The guard picks its placement from the hardware and tries the options in order. It takes the first one that fits in free memory (with headroom); the last option is used even if it does not fit. A model is about 3.6 GiB (4B) or 1.4 GiB (0.6B) in memory.

| Hardware | Order of placements | During image generation |
| --- | --- | --- |
| No GPU | 4B on CPU, 0.6B on CPU | Keeps running |
| Integrated GPU (shared memory) | 4B on GPU, 4B on CPU, 0.6B on GPU, 0.6B on CPU | Stopped, so the image model gets the memory |
| Discrete GPU, 8 GiB or less (or unknown) | 4B on CPU, 0.6B on GPU, 0.6B on CPU | CPU placements keep running; the 0.6B on GPU is stopped |
| Discrete GPU, more than 8 GiB | 4B on GPU, 4B on CPU, 0.6B on GPU, 0.6B on CPU | CPU placements keep running; GPU placements are stopped |

- The 0.6B is a fallback only: on the project's 50-prompt Polish test set it missed 8 of 30 harmful prompts and blocked 4 of 20 harmless ones, while the 4B (Q4_K_M) missed 4 and blocked 1 (word list not counted). To forbid it, set `KIDS_GUARD_ALLOW_SMALL_FALLBACK = false` in `WebUI/electron/safety/kidsGuard.ts`; the 0.6B is then never planned or downloaded.
- Missing or unknown memory figures count as "does not fit". If no placement can start, every check is blocked as before.
- CPU placements use the performance plus efficiency cores (not the low-power E-cores): batch threads clamped to 4-8, generation threads up to 4. Without topology data, half the logical CPUs (4-8). GPU placements use 2 threads.
- Image prompts are checked before the GPU is handed to image generation, so a guard that has to stop is already done. Chat prompts are checked once the chat model is ready.

## Code

- `WebUI/electron/safety/kidsGuard.ts` – guard client, word list, reply holding.
- `WebUI/electron/safety/guardPlacement.ts`, `WebUI/electron/safety/guardFacts.ts`, `WebUI/electron/safety/cpuTopology.ts` – placement rules, the hardware facts they use and CPU thread counts.
- `WebUI/electron/adapters/backends/llamaCppBackendService.ts` – `ensureGuardServer` (ignores user startup parameters).
- `WebUI/electron/chat/turnEngine.ts` (chat prompts and replies), `WebUI/electron/kernel/orchestrator.ts` (image prompts) – where text is checked.
- `comfyui-deps/custom_nodes/SafetyChecker/nodes.py` and `modes/base/` presets – image output filter.

## Limits

No filter is perfect. On a 50-prompt Polish test set the 4B guard plus the word list missed 0 of 30 harmful prompts and blocked 1 of 20 harmless ones (a family in swimsuits at the pool); the set is small, so treat that as indicative. Short Polish slang is the weakest area, which is what the word list is for. The image threshold of 0.4 was chosen on a 136-image test (no explicit images): it blocked all 11 swimwear, lingerie and reclining-nude images, but also about 1 in 5 harmless images generated from kid prompts (the SD1.5 model tends to draw "girl", "mermaid" or "ballerina" as glamorous adults) and 5 of 64 harmless photos; a blocked image comes back black. Video presets and text-to-speech are not filtered. Use this together with a separate non-admin account for the child and OS parental controls: a child with admin rights can edit presets, the ComfyUI workflows or the app itself.
