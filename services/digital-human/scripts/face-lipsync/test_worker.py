import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch
import wave
import worker

import numpy as np
from worker import QualityError, choose_delay, crop_plan, pad_audio, frame_offset, prepare, composite


class FaceWorkflowTests(unittest.TestCase):
    def test_tiny_secondary_detection_does_not_reject_the_only_usable_face(self):
        info = {"width":720,"height":1280,"duration":1}
        main = [318,462,117,160,348,527,403,525,375,559,355,581,402,579,.94]
        hand = [440,807,70,91,488,833,503,837,507,848,485,872,496,868,.76]
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([main,hand],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([np.zeros((1280,720,3),dtype=np.uint8)]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            _,data = worker.track("source.mp4")
        np.testing.assert_array_equal(data,np.tile(np.array(main[:14]),(6,1)))

    def test_two_usable_faces_still_rejected(self):
        info = {"width":720,"height":1280,"duration":1}
        row = [20,20,100,120,40,40,70,40,55,60,40,80,70,80,.95]
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([row,row],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([np.zeros((1280,720,3),dtype=np.uint8)])), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"More than one face"):
                worker.track("source.mp4")

    def test_looped_source_detects_identical_frames_once_and_keeps_full_track(self):
        info = {"width":128,"height":128,"duration":1}
        images = [np.full((128,128,3), i, dtype=np.uint8) for i in range(3)]
        rows = []
        class Detector:
            def detect(self, frame):
                i = int(frame[0,0,0])
                row = np.array([20+i,20,80,90,40,40,70,40,55,60,40,80,70,80,.99], dtype=np.float32)
                rows.append(row[:14])
                return None, row[None]
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter(images*3)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=Detector()):
            _, data = worker.track("source.mp4",duration=3,loop=True)
        self.assertEqual(len(rows),3,"repeated source frames must not rerun face inference")
        self.assertEqual(len(data),9,"every decoded frame still needs a face position")
        expected = worker.median_filter(np.tile(np.array(rows),(3,1)),size=(3,1),mode="nearest")
        np.testing.assert_array_equal(data,expected)

    def test_reused_missing_faces_still_count_every_frame_against_coverage_gate(self):
        info = {"width":128,"height":128,"duration":1}
        image = np.zeros((128,128,3),dtype=np.uint8)
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,None)
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([image]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"Face missing for more than five frames"):
                worker.track("source.mp4",duration=3,loop=True)
        self.assertEqual(detector.detect.call_count,1)

    def test_non_looped_source_still_detects_all_frames(self):
        info = {"width":128,"height":128,"duration":3}
        image = np.zeros((128,128,3),dtype=np.uint8)
        detector = unittest.mock.Mock()
        detector.detect.return_value = (None,np.array([[20,20,80,90,40,40,70,40,55,60,40,80,70,80,.99]],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter([image]*6)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            _,data = worker.track("source.mp4",duration=3,loop=False)
        self.assertEqual(detector.detect.call_count,6)
        self.assertEqual(len(data),6)

    def test_reused_track_still_rejects_a_jump_at_each_loop_join(self):
        info = {"width":256,"height":256,"duration":1}
        images = [np.full((256,256,3),i,dtype=np.uint8) for i in range(3)]
        detector = unittest.mock.Mock()
        detector.detect.side_effect = lambda frame:(None,np.array([[int(frame[0,0,0])*30,20,80,90,40,40,70,40,55,60,40,80,70,80,.99]],dtype=np.float32))
        with patch("worker.probe",return_value=info), \
             patch("worker.frames",return_value=iter(images*3)), \
             patch("worker.cv2.FaceDetectorYN.create",return_value=detector):
            with self.assertRaisesRegex(QualityError,"Face track jumps or source contains a cut"):
                worker.track("source.mp4",duration=3,loop=True)
        self.assertEqual(detector.detect.call_count,3)

    def test_alignment_uses_full_validated_source_track_in_output_coordinates(self):
        data = np.arange(60 * 14, dtype=float).reshape(60, 14)
        info = {"width":640, "height":480, "duration":2}
        measured = []
        def scores(video, audio, face_track=None, model=None):
            measured.append(face_track)
            return [{"delayMs":0,"confidence":5}]
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory)/"candidate.mp4")
            (Path(directory)/"face-manifest.json").write_text(json.dumps({"version":1, "durationSeconds":2,
                "source":{"width":1280,"height":960}, "track":data.tolist()}))
            with patch("worker.load_syncnet", return_value=object()), \
                 patch("worker.track", side_effect=AssertionError("validated source must not be detected again")), \
                 patch("worker.sync_scores", side_effect=scores), patch("worker.probe", return_value=info), \
                 patch("worker.ffmpeg", side_effect=lambda args:Path(args[-1]).touch()):
                worker.align({"videoPath":"video.mp4","audioPath":"voice.wav","outputPath":output,"jobDir":directory})
            self.assertEqual(len(measured),2)
            for frame_track in measured:
                np.testing.assert_array_equal(frame_track[1],data*0.5)

    def test_sync_face_crop_matches_full_frame_padding_at_image_edges(self):
        frame = np.random.default_rng(41).integers(0, 256, (240, 320, 3), dtype=np.uint8)
        for box in [(53, 61, 182, 217), (-19, -13, 113, 165), (211, 170, 369, 283), (-20, -20, 340, 260)]:
            x1, y1, x2, y2 = box
            padded = worker.cv2.copyMakeBorder(frame, max(0, -y1), max(0, y2-240), max(0, -x1), max(0, x2-320), worker.cv2.BORDER_CONSTANT)
            expected = padded[max(0, y1):max(0, y1)+y2-y1, max(0, x1):max(0, x1)+x2-x1]
            np.testing.assert_array_equal(worker.sync_face_crop(frame, box), expected)

    def test_alignment_reuses_validated_geometry_after_padding_but_still_measures_encoded_candidate(self):
        data = np.arange(60 * 14, dtype=float).reshape(60, 14)
        info = {"width": 640, "height": 480, "duration": 2}
        model = object()
        measured = []
        def scores(video, audio, face_track=None, model=None):
            measured.append((video, audio, face_track, model))
            return [{"delayMs": -80 if len(measured) == 1 else 0, "confidence": 5}]
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "candidate.mp4")
            def encode(args):
                Path(args[-1]).touch()
            with patch("worker.load_syncnet", return_value=model) as loaded, \
                 patch("worker.track", return_value=(info, data)) as tracked, \
                 patch("worker.sync_scores", side_effect=scores), \
                 patch("worker.probe", return_value=info), patch("worker.ffmpeg", side_effect=encode):
                worker.align({"videoPath":"video.mp4", "audioPath":"voice.wav", "outputPath":output, "jobDir":directory})
            self.assertEqual(loaded.call_count, 1)
            self.assertEqual(tracked.call_count, 1)
            self.assertEqual(len(measured), 2, "encoded output still needs complete SyncNet measurement")
            self.assertEqual(measured[1][:2], (output, output))
            self.assertIs(measured[0][3], model)
            self.assertIs(measured[1][3], model)
            np.testing.assert_array_equal(measured[1][2][1][:2], np.repeat(data[:1], 2, axis=0))
            np.testing.assert_array_equal(measured[1][2][1][2:], data)

    def test_encoded_candidate_alignment_failure_still_removes_deliverable(self):
        data = np.ones((60, 14))
        info = {"width":640, "height":480, "duration":2}
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory)/"candidate.mp4")
            with patch("worker.load_syncnet", return_value=object()), patch("worker.track", return_value=(info,data)), \
                 patch("worker.sync_scores", side_effect=[[{"delayMs":0,"confidence":5}], [{"delayMs":80,"confidence":5}]]), \
                 patch("worker.probe", return_value=info), \
                 patch("worker.ffmpeg", side_effect=lambda args:Path(args[-1]).touch()):
                with self.assertRaises(QualityError):
                    worker.align({"videoPath":"video.mp4", "audioPath":"voice.wav", "outputPath":output, "jobDir":directory})
            self.assertFalse(Path(output).exists())

    def test_mouth_roi_matches_full_crop_math_pixel_for_pixel(self):
        rng = np.random.default_rng(37)
        frame = rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)
        patch_image = rng.integers(0, 256, (160, 160, 3), dtype=np.uint8)
        for cx, cy, rx, ry in [(80.3, 92.7, 26.8, 17.5), (4.1, 155.7, 27.2, 16.6), (200, 80, 22, 19)]:
            yy, xx = np.mgrid[0:160, 0:160]
            radius = np.sqrt(((xx-cx)/rx)**2 + ((yy-cy)/ry)**2)
            alpha = np.clip((1-radius)/0.3, 0, 1)
            alpha = (alpha*alpha*(3-2*alpha))[:, :, None]
            expected = frame.copy()
            region = expected[40:200, 60:220]
            expected[40:200, 60:220] = np.clip(region*(1-alpha)+patch_image*alpha, 0, 255).astype(np.uint8)
            actual = worker.blend_mouth(frame, patch_image, 60, 40, cx, cy, rx, ry)
            np.testing.assert_array_equal(actual, expected)
            np.testing.assert_array_equal(frame[:40], actual[:40])

    def test_short_narration_fails_before_model_loading_or_paid_work(self):
        with self.assertRaises(QualityError) as caught:
            prepare({"jobDir": "/unused", "durationSeconds": 0.8})
        self.assertEqual(caught.exception.code, "LIPSYNC_INPUT_DURATION")

    def test_padding_keeps_every_original_pcm_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "voice.wav", Path(directory) / "padded.wav"
            pcm = np.arange(12345, dtype=np.int16).tobytes()
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                wav.writeframes(pcm)
            duration = pad_audio(source, target)
            with wave.open(str(target), "rb") as wav:
                result = wav.readframes(wav.getnframes())
            lead, tail = round(0.6 * 22050) * 2, round(0.3 * 22050) * 2
            self.assertEqual(result[:lead], bytes(lead))
            self.assertEqual(result[lead:-tail], pcm)
            self.assertEqual(result[-tail:], bytes(tail))
            self.assertEqual(duration, 12345 / 22050)

    def test_crop_uses_native_coordinates_and_contains_moving_face(self):
        data = np.array([[1000, 1400, 210, 260], [1070, 1410, 210, 260]], dtype=float)
        result = crop_plan({"width": 2160, "height": 3840}, data)
        self.assertEqual(result["outputSize"], 768)
        self.assertEqual(result["size"], 768)
        self.assertLessEqual(result["x"], 1000)
        self.assertGreaterEqual(result["x"] + result["size"], 1280)
        self.assertLessEqual(result["y"], 1400)
        self.assertGreaterEqual(result["y"] + result["size"], 1670)

    def test_small_native_face_is_not_made_valid_by_upscaling(self):
        with self.assertRaises(QualityError):
            crop_plan({"width": 2160, "height": 3840}, np.array([[1000, 1400, 40, 55]], dtype=float))

    def test_alignment_uses_measured_delay_in_either_direction(self):
        for value in [-120, 0, 80]:
            self.assertEqual(choose_delay([{"delayMs": value, "confidence": 5}] * 3), value)
        for low, high in [(-40, 0), (0, 40), (80, 120)]:
            rows = [{"delayMs": value, "confidence": 5} for value in [low, high, high]]
            self.assertEqual(choose_delay(rows), (low + high) / 2)

    def test_frame_registration_uses_one_offset_and_rejects_local_speed_changes(self):
        source = np.random.default_rng(7).uniform(0, 255, (100, 12, 32, 3)).astype(np.float32)
        for delay in [-2, 0, 1]:
            rendered = np.concatenate([np.repeat(source[:1], 18 + delay, axis=0), source, np.repeat(source[-1:], 9, axis=0)])
            self.assertEqual(frame_offset(source, rendered, 18), delay)
        warped = np.concatenate([np.repeat(source[:1], 18, axis=0), source[:50], source[52:], np.repeat(source[-1:], 11, axis=0)])
        with self.assertRaises(QualityError):
            frame_offset(source, warped, 18)

    def test_local_speed_mismatch_and_uncertain_match_are_not_global_offsets(self):
        for rows in [[], [{"delayMs": 0, "confidence": 1}],
                     [{"delayMs": 200, "confidence": 8}],
                     [{"delayMs": 0, "confidence": 5}, {"delayMs": 120, "confidence": 6}]]:
            with self.assertRaises(QualityError):
                choose_delay(rows)

    def test_composite_registers_against_exact_provider_input_not_rescaled_base(self):
        source = np.random.default_rng(9).uniform(0, 255, (60, 12, 32, 3)).astype(np.float32)
        tail = np.repeat(source[-1:], 9, axis=0)
        rendered = np.concatenate([np.repeat(source[:1], 18, axis=0), source, tail])
        reference = np.concatenate([source, tail])
        unrelated_base = np.roll(source, 12, axis=0)
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "face-input.mp4").touch()
            (job / "face-manifest.json").write_text(json.dumps({"durationSeconds": 2,
                "source": {"width": 64, "height": 64}, "crop": {"x": 0, "y": 0, "size": 64}}))
            def decoded(file, *args, **kwargs):
                if Path(file).name == "face-input.mp4":
                    self.assertIn("trim=start_frame=18", kwargs["extra"])
                    return iter(reference)
                return iter(rendered if Path(file).name == "rendered.mp4" else unrelated_base)
            # Stop just before encoding; exercise the actual correspondence
            # check using decoded-frame fixtures without loading face models.
            with patch("worker.probe", return_value={"width": 64, "height": 64, "duration": 2.9}), \
                 patch("worker.frames", side_effect=decoded), \
                 patch("worker.sp.Popen", side_effect=RuntimeError("registration-passed")):
                with self.assertRaisesRegex(RuntimeError, "registration-passed"):
                    composite({"jobDir": str(job), "renderedPath": str(job / "rendered.mp4")})
            self.assertEqual(json.loads((job / "face-registration.json").read_text())["fixedFrameOffset"], 0)


if __name__ == "__main__":
    unittest.main()
