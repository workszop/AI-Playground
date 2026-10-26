# Safety gaps

This document lists content-safety gaps in two builds:

- Intel AI Playground at upstream commit `611cd46`.
- Kids-safe AI Playground as of the current `main`.

It covers only what a user of the app can see or hear. Security bugs, privacy and data handling are out of scope.

## Intel AI Playground (upstream `611cd46`)

### Text

- Nothing checks text. A message the user types reaches the model as written, and the model's reply is shown as it streams.
- The model's reasoning text ("thinking") is shown to the user without any check.
- Chat tools run without a check. That includes web search, page browsing, MCP servers and the media tools. The queries a tool sends and the text it returns both appear on the tool card.
- Image and video prompts go to ComfyUI without a check.

### Images

- The NSFW image filter is a "Safety Check" slider in the image settings. The user can change it at any time:
  - standard presets default to 0.5, which blocks images that score above 0.5;
  - demo presets default to 0.93, which blocks images that score above 0.07;
  - at 0 the filter never blocks.
- In a batch of images, the filter scores only the first image. If that one passes, the rest of the batch is saved and shown without a check.
- Several presets have no filter at all: Colorize, Change Face, Upscale and the OpenVINO variants.
- The Acer VisionArt preset shows the Safety Check slider but has no filter node, so the slider does nothing.
- Live preview is on by default. It shows unfiltered intermediate frames while an image is being generated.
- Presets and the filter's node files are copied to a folder every user on the computer can write to. Removing the filter node from a preset, or editing its code, turns the filter off without any warning.

### Other media

- Video presets have no output filter.
- 3D model presets (Image To 3D Model, Pixel3D-Trellis) have no output filter.
- The Text to Speech and Speech to Text presets have no check.

### Agents and remote access

- Agent Mode (Agent, Game Agent, Quick Coder) runs a separate agent harness that writes files, browses and generates media, and no check sits between it and the user.
- Home Agent makes the local models reachable through Telegram, Slack or a web page on the local network. Nothing checks those conversations either.

### Models

- Any Hugging Face chat model can be added in the Model Manager, including models tuned to refuse nothing. No check stands between such a model and the user.

## Kids-safe AI Playground (current `main`)

### Media without an output filter

- Video presets: the prompt is checked, but the generated video is not.
- 3D model presets: the generated model and its textures are not checked. The image filter applies only to still-image presets.
- Text to Speech speaks typed text without a check.
- Speech to Text shows the transcript without a check. This includes the transcript of an audio file the user uploads.

### Chat tools

- Images returned by chat tools are not checked. That covers web page screenshots, screenshots of the window bound to the screenshot tool, and object-detection overlays. Only text in tool output is judged.
- A tool input that is just a URL (for example the page address `browseWeb` opens) is not judged. Only the page text that comes back is.
- The built-in browser window can be opened from the chat's activity indicator. It shows the live page the model is reading, images included, with no filtering. There is no site blocklist and no SafeSearch.

### Inputs the user provides

- Images attached to a chat (for vision models), documents added for RAG and source images for Image Edit are not checked. Only the text or images the app generates from them are checked.

### Filter accuracy

- The text check was tested on 50 Polish prompts only. That set is too small to estimate how often harmful text gets through.
- When the main 4B guard model does not fit in memory, the smaller 0.6B model takes over. Without the word list, it missed 8 of 30 harmful prompts in that test.
- The word list covers Polish and English only.
- The image classifier at threshold 0.4 was tested on 136 images, and none of them was explicitly adult. It also blocks about one in five harmless SD1.5 images.

### Tampering

- An administrator can change the app itself.
- The integrity check that runs before each image generation covers only the workflow sent to ComfyUI and the `SafetyChecker` node files. ComfyUI itself and the NSFW detector model live in a folder every user can write to, so someone who knows Python can change them.

### Oversight

- A blocked request leaves only a log line with the verdict level, not the text. There is no report or history an adult can review, and the user can delete their conversations.
