"""Detect speech in 16 kHz mono PCM with the bundled Silero VAD ONNX model."""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort


def detect(path):
    audio = np.fromfile(path, dtype='<f4')
    options = ort.SessionOptions()
    options.inter_op_num_threads = options.intra_op_num_threads = 1
    model = ort.InferenceSession(str(Path(__file__).with_name('silero_vad.onnx')),
                                sess_options=options, providers=['CPUExecutionProvider'])
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    intervals, start, quiet = [], None, None
    for offset in range(0, len(audio), 512):
        chunk = np.pad(audio[offset:offset + 512], (0, max(0, offset + 512 - len(audio))))[None, :]
        window = np.concatenate((context, chunk), axis=1)
        probability, state = model.run(None, {'input': window, 'state': state, 'sr': np.array(16000, dtype=np.int64)})
        context = window[:, -64:]
        probability = float(probability[0, 0])
        if probability >= 0.5:
            quiet = None
            if start is None:
                start = offset
        elif start is not None and probability < 0.35:
            if quiet is None:
                quiet = offset
            if offset - quiet >= 1600:
                if quiet - start >= 1600:
                    intervals.append({'start': start / 16000, 'end': quiet / 16000})
                start, quiet = None, None
    if start is not None and len(audio) - start >= 1600:
        intervals.append({'start': start / 16000, 'end': len(audio) / 16000})
    return intervals


if __name__ == '__main__':
    print(json.dumps(detect(sys.argv[1])))
