from __future__ import annotations

import base64
import mimetypes
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class VisionReport:
    hazard_name: str
    threat_level: int          # 0-10, -1 if unknown
    summary: str
    raw_text: str
    image_path: Optional[str]


class VisionAnalyzer:
    """Runs drone images through Claude's vision API. Falls back to a stub
    (threat_level=-1) if the SDK or API key is missing, so the pipeline stays
    runnable in dev without credentials.

    Uses prompt caching on the system prompt: when the monitor runs many
    incidents in a row, the cached prompt yields big savings.
    """

    _DEFAULT_SYSTEM = (
        "You are an emergency-response vision analyst. Given an aerial drone "
        "image and a hazard-specific question, respond with:\n"
        "Line 1: THREAT_LEVEL: <integer 0-10>\n"
        "Line 2+: a concise field report (<120 words) including recommended actions.\n"
        "Be decisive and specific. If the image does not show the hazard, say so plainly."
    )

    def __init__(
        self,
        model: str = "claude-opus-4-7",
        api_key: Optional[str] = None,
        system_prompt: Optional[str] = None,
    ):
        self.model = model
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.system_prompt = system_prompt or self._DEFAULT_SYSTEM
        self._client = self._make_client()

    def _make_client(self):
        if not self.api_key:
            return None
        try:
            import anthropic  # type: ignore
        except ImportError:
            return None
        return anthropic.Anthropic(api_key=self.api_key)

    def analyze(
        self,
        image_path: Optional[str],
        hazard_name: str,
        vision_prompt: str,
    ) -> VisionReport:
        if self._client is None or image_path is None:
            return self._stub_report(hazard_name, image_path)

        media_type, data_b64 = self._encode_image(image_path)

        response = self._client.messages.create(
            model=self.model,
            max_tokens=512,
            system=[
                {
                    "type": "text",
                    "text": self.system_prompt,
                    # Cache the system prompt — reused across all incidents.
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": data_b64,
                            },
                        },
                        {"type": "text", "text": vision_prompt},
                    ],
                }
            ],
        )
        text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )
        return VisionReport(
            hazard_name=hazard_name,
            threat_level=self._parse_threat_level(text),
            summary=self._first_paragraph(text),
            raw_text=text,
            image_path=image_path,
        )

    @staticmethod
    def _encode_image(path: str) -> tuple[str, str]:
        p = Path(path)
        media_type = mimetypes.guess_type(p.name)[0] or "image/jpeg"
        return media_type, base64.standard_b64encode(p.read_bytes()).decode()

    @staticmethod
    def _parse_threat_level(text: str) -> int:
        m = re.search(r"THREAT_LEVEL\s*:\s*(\d{1,2})", text, re.IGNORECASE)
        if not m:
            return -1
        return max(0, min(10, int(m.group(1))))

    @staticmethod
    def _first_paragraph(text: str) -> str:
        for para in text.strip().split("\n\n"):
            stripped = para.strip()
            if stripped and not stripped.upper().startswith("THREAT_LEVEL"):
                return stripped
        return text.strip()[:200]

    @staticmethod
    def _stub_report(hazard_name: str, image_path: Optional[str]) -> VisionReport:
        reason = "no API key / SDK" if image_path else "no image captured"
        return VisionReport(
            hazard_name=hazard_name,
            threat_level=-1,
            summary=f"[vision unavailable: {reason}]",
            raw_text="",
            image_path=image_path,
        )
