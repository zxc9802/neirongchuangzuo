SyncNet v2 model and architecture: Joon Son Chung and Andrew Zisserman,
“Out of time: automated lip sync in the wild”, ACCV workshop, 2016.
https://www.robots.ox.ac.uk/~vgg/software/lipsync/
https://github.com/joonson/syncnet_python
The Oxford download page links Creative Commons Attribution 4.0:
https://creativecommons.org/licenses/by/4.0/
This integration uses a rewritten inference-only architecture, CPU execution,
YuNet face detection, streaming frames and per-section alignment checks.

YuNet face_detection_yunet_2023mar.onnx:
https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet

MediaPipe SelfieMulticlass (256 x 256), float32 version 1:
Copyright Google LLC. Licensed under Apache License 2.0; see LICENSE-mediapipe.txt.
https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter
https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf
Used to refine source-frame hand masks; outputs are gated by detected hand regions
and adapted with a narrow protective boundary margin before blending.
Model weights are downloaded without modification.

MediaPipe HandLandmarker, float16 version 1:
Copyright Google LLC. Licensed under Apache License 2.0; see LICENSE-mediapipe.txt.
https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
Used to restrict occlusion protection to hands detected in each full source frame.
Model weights are downloaded without modification.

MIT License

Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
