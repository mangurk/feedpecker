from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
ICON_DIRECTORY = ROOT / "assets" / "icons"
SOURCE = ICON_DIRECTORY / "feedpecker-original-transparent.png"
MASTER = ICON_DIRECTORY / "icon-master.png"
SVG = ICON_DIRECTORY / "icon.svg"
MASTER_SIZE = 1024
PADDING_RATIO = 0.08


def normalized_master(source: Image.Image) -> Image.Image:
    rgba = source.convert("RGBA")
    alpha = rgba.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("The icon source has no visible pixels.")

    cropped = rgba.crop(bounds)
    longest_edge = max(cropped.size)
    padding = max(1, round(longest_edge * PADDING_RATIO))
    canvas_edge = longest_edge + (padding * 2)
    canvas = Image.new("RGBA", (canvas_edge, canvas_edge), (0, 0, 0, 0))
    x = (canvas_edge - cropped.width) // 2
    y = (canvas_edge - cropped.height) // 2
    canvas.alpha_composite(cropped, (x, y))
    return canvas.resize((MASTER_SIZE, MASTER_SIZE), Image.Resampling.LANCZOS)


def png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def main() -> None:
    master = normalized_master(Image.open(SOURCE))
    master_data = png_bytes(master)
    MASTER.write_bytes(master_data)

    for size in (16, 48, 128):
        exported = master.resize((size, size), Image.Resampling.LANCZOS)
        destination = ICON_DIRECTORY / f"{size}.png"
        destination.write_bytes(png_bytes(exported))
        print(f"Exported {destination}")

    encoded = base64.b64encode(master_data).decode("ascii")
    SVG.write_text(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<svg xmlns=\"http://www.w3.org/2000/svg\" "
        "xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 1024 1024\" "
        "role=\"img\" aria-label=\"Feedpecker woodpecker icon\">\n"
        f"  <image width=\"1024\" height=\"1024\" href=\"data:image/png;base64,{encoded}\" "
        f"xlink:href=\"data:image/png;base64,{encoded}\"/>\n"
        "</svg>\n",
        encoding="utf-8",
    )
    print(f"Exported {MASTER}")
    print(f"Exported {SVG}")


if __name__ == "__main__":
    main()
