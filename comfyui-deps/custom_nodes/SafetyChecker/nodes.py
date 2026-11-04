# Adapted from https://github.com/BetaDoggo/ComfyUI-YetAnotherSafetyChecker/
# Copyright (c) 2024 BetaDoggo
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Modified to use local model paths from ComfyUI's
# folder_paths instead of HuggingFace Hub for offline capability.
# Modified for the kids-safe build to check every image in the batch and to stop
# the run instead of blacking out the batch, so nothing is saved and the app can
# say why.

import os

import folder_paths
import numpy as np
from PIL import Image
from transformers import pipeline

# The app matches this text in ComfyUI's execution_error to show its blocked message.
BLOCKED_MARKER = "AIPG_KIDS_SAFE_BLOCKED"


class SafetyChecker:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "threshold": (
                    "FLOAT",
                    {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    FUNCTION = "process_images"

    CATEGORY = "image/processing"

    def process_images(self, image, threshold):
        device = "cpu"
        predict = pipeline(
            "image-classification",
            model=os.path.join(
                folder_paths.get_folder_paths("nsfw_detector")[0],
                "vit-base-nsfw-detector",
            ),
            device=device,
        )  # init pipeline
        result = predict(
            [
                Image.fromarray((img.cpu().numpy() * 255).astype(np.uint8))
                for img in image
            ]
        )  # Convert to expected format
        score = max(
            next(item["score"] for item in res if item["label"] == "nsfw")
            for res in result
        )
        if float(score) > threshold:
            # One frame over the threshold blocks the whole batch or video.
            raise RuntimeError(f"{BLOCKED_MARKER} score={float(score):.3f}")
        return (image, str(score))


NODE_CLASS_MAPPINGS = {"SafetyChecker": SafetyChecker}

NODE_DISPLAY_NAME_MAPPINGS = {"SafetyChecker": "Safety Checker"}
