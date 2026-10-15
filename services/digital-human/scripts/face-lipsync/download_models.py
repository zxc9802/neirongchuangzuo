"""Download pinned public weights at build/setup time, never during a job."""
import hashlib
from pathlib import Path
import sys
import urllib.request

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
models = [
    ("yunet.onnx", "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
     "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("syncnet_v2.model", "https://www.robots.ox.ac.uk/~vgg/software/lipsync/data/syncnet_v2.model",
     "961e8696f888fce4f3f3a6c3d5b3267cf5b343100b238e79b2659bff2c605442"),
]
for name, url, digest in models:
    target = root / name
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Model checksum mismatch: {name}")
    target.write_bytes(data)
    print(f"Verified {name}")
