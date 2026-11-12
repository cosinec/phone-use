"""Adapter and JSONL regression tests. No Paddle models or device required."""
import base64
import importlib.util
import io
import json
import os
import subprocess
import sys
import types
from pathlib import Path
import unittest
from unittest.mock import patch

from PIL import Image

WORKER_PATH = Path(__file__).with_name('worker.py')


def image_base64(width=80, height=40, color=(255, 0, 0)):
    output = io.BytesIO()
    Image.new('RGB', (width, height), color).save(output, format='PNG')
    return base64.b64encode(output.getvalue()).decode('ascii')


def rectangle(x, y, width=10, height=5):
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]


class FakeEngine:
    def __init__(self, texts=None, scores=None, polygons=None):
        self.calls = []
        self.result = {
            'rec_texts': texts or [],
            'rec_scores': scores or [],
            'rec_polys': polygons or [],
        }

    def predict(self, image):
        self.calls.append(image)
        yield self.result


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = None
        if WORKER_PATH.exists():
            spec = importlib.util.spec_from_file_location('ocr_worker', WORKER_PATH)
            cls.worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.worker)

    def setUp(self):
        self.assertIsNotNone(self.worker, 'OCR worker implementation is required')

    def run_requests(self, requests, engine=None):
        engine = engine or FakeEngine()
        factory_calls = []

        def factory():
            factory_calls.append(True)
            return engine

        source = io.BytesIO(b''.join(
            (json.dumps(request) + '\n').encode() if isinstance(request, dict) else request
            for request in requests
        ))
        output = io.BytesIO()
        self.worker.serve(source, output, factory)
        return [json.loads(line) for line in output.getvalue().splitlines()], factory_calls, engine

    def test_recognizes_exact_raster_and_reuses_engine(self):
        engine = FakeEngine(['中文 Settings'], [0.95], [rectangle(5, 4)])
        requests = [{'id': str(index), 'imageBase64': image_base64()} for index in range(2)]
        results, calls, _ = self.run_requests(requests, engine)
        self.assertEqual(len(calls), 1)
        self.assertEqual(results[0], {
            'id': '0', 'width': 80, 'height': 40,
            'lines': [{'text': '中文 Settings', 'confidence': 0.95, 'polygon': rectangle(5, 4)}],
            'truncated': False,
        })
        self.assertEqual(results[1]['id'], '1')
        self.assertEqual(engine.calls[0].shape, (40, 80, 3))
        self.assertEqual(engine.calls[0][0, 0].tolist(), [0, 0, 255])

    def test_reading_order_is_top_then_left(self):
        engine = FakeEngine(['bottom', 'right', 'left'], [0.9] * 3,
                            [rectangle(2, 20), rectangle(40, 4), rectangle(2, 4)])
        results, _, _ = self.run_requests([{'id': 'order', 'imageBase64': image_base64()}], engine)
        self.assertEqual([line['text'] for line in results[0]['lines']], ['left', 'right', 'bottom'])

    def test_bad_requests_are_generic_and_next_request_still_works(self):
        requests = [b'{secret malformed\n', {'id': 'bad', 'imageBase64': 'not-base64'},
                    {'id': 'bad-image', 'imageBase64': base64.b64encode(b'secret').decode()},
                    {'id': 'good', 'imageBase64': image_base64()}]
        results, calls, _ = self.run_requests(requests)
        self.assertEqual(results[:3], [{'id': '', 'error': 'OCR request failed'},
                                      {'id': 'bad', 'error': 'OCR request failed'},
                                      {'id': 'bad-image', 'error': 'OCR request failed'}])
        self.assertEqual(results[3]['lines'], [])
        self.assertEqual(len(calls), 1)

    def test_invalid_ids_and_non_object_json_are_rejected_before_loading_models(self):
        requests = [b'[]\n', {'id': '', 'imageBase64': image_base64()},
                    {'id': 42, 'imageBase64': image_base64()},
                    {'id': 'x' * 129, 'imageBase64': image_base64()}]
        results, calls, _ = self.run_requests(requests)
        self.assertTrue(all(result == {'id': '', 'error': 'OCR request failed'} for result in results))
        self.assertEqual(calls, [])

    def test_invalid_polygons_and_scores_fail_closed(self):
        invalid = [rectangle(-1, 0), rectangle(75, 0), [[0, 0]] * 3,
                   [[0, 0], [1, 0], [1, float('nan')], [0, 1]],
                   [[0, 0], [1, 0], [1, 1], [0, '1']]]
        for polygon in invalid:
            with self.subTest(polygon=polygon):
                result, _, _ = self.run_requests([{'id': 'poly', 'imageBase64': image_base64()}],
                                                FakeEngine(['secret'], [0.9], [polygon]))
                self.assertEqual(result, [{'id': 'poly', 'error': 'OCR request failed'}])
        for score in [-0.1, 1.1, float('inf'), '0.9']:
            with self.subTest(score=score):
                result, _, _ = self.run_requests([{'id': 'score', 'imageBase64': image_base64()}],
                                                FakeEngine(['secret'], [score], [rectangle(0, 0)]))
                self.assertEqual(result, [{'id': 'score', 'error': 'OCR request failed'}])

    def test_mismatched_recognition_arrays_fail_closed(self):
        result, _, _ = self.run_requests([{'id': 'shape', 'imageBase64': image_base64()}],
                                        FakeEngine(['secret'], [0.9], []))
        self.assertEqual(result, [{'id': 'shape', 'error': 'OCR request failed'}])

    def test_dimensions_are_checked_before_model_initialization(self):
        with patch.object(self.worker, 'MAX_DIMENSION', 32):
            results, calls, _ = self.run_requests([{'id': 'wide', 'imageBase64': image_base64()}])
        self.assertEqual(results, [{'id': 'wide', 'error': 'OCR request failed'}])
        self.assertEqual(calls, [])

    def test_oversize_line_is_drained_and_next_request_runs(self):
        request = {'id': 'after', 'imageBase64': image_base64()}
        with patch.object(self.worker, 'MAX_INPUT_LINE_BYTES', 512):
            results, calls, _ = self.run_requests([b'x' * 1024 + b'\n', request])
        self.assertEqual(results[0], {'id': '', 'error': 'OCR request failed'})
        self.assertEqual(results[1]['id'], 'after')
        self.assertEqual(len(calls), 1)

    def test_output_and_text_limits_report_truncation(self):
        engine = FakeEngine(['long text', 'second'], [0.9, 0.8], [rectangle(0, 0), rectangle(0, 10)])
        with patch.object(self.worker, 'MAX_TEXT_CHARS', 4), patch.object(self.worker, 'MAX_LINES', 1):
            results, _, _ = self.run_requests([{'id': 'limit', 'imageBase64': image_base64()}], engine)
        self.assertEqual(results[0]['lines'][0]['text'], 'long')
        self.assertTrue(results[0]['truncated'])
        with patch.object(self.worker, 'MAX_OUTPUT_BYTES', 120):
            results, _, _ = self.run_requests([{'id': 'bytes', 'imageBase64': image_base64()}], engine)
        self.assertTrue(results[0]['truncated'])
        self.assertLessEqual(len(self.worker.encode_response(results[0])), 120)

    def test_valid_unicode_id_and_invalid_surrogate_do_not_break_protocol(self):
        results, _, _ = self.run_requests([
            {'id': '\ud800', 'imageBase64': image_base64()},
            {'id': '中文', 'imageBase64': image_base64()},
        ])
        self.assertEqual(results[0], {'id': '', 'error': 'OCR request failed'})
        self.assertEqual(results[1]['id'], '中文')

    def test_success_response_includes_final_boolean_in_byte_limit(self):
        engine = FakeEngine(['text'], [0.9], [rectangle(0, 0)])
        request = {'id': 'size', 'imageBase64': image_base64()}
        initial, _, _ = self.run_requests([request], engine)
        budget = len(self.worker.encode_response(initial[0])) - 1
        with patch.object(self.worker, 'MAX_OUTPUT_BYTES', budget):
            results, _, _ = self.run_requests([request], engine)
        self.assertLessEqual(len(self.worker.encode_response(results[0])), budget)
        self.assertTrue(results[0]['truncated'])

    def test_engine_uses_cpu_mobile_models_and_disables_coordinate_transforms(self):
        with patch.dict(sys.modules, {'paddleocr': types.SimpleNamespace(PaddleOCR=lambda **kw: kw)}):
            config = self.worker.create_engine()
        self.assertEqual(config['device'], 'cpu')
        self.assertEqual(config['text_detection_model_name'], 'PP-OCRv5_mobile_det')
        self.assertEqual(config['text_recognition_model_name'], 'PP-OCRv5_mobile_rec')
        for key in ('use_doc_orientation_classify', 'use_doc_unwarping', 'use_textline_orientation'):
            self.assertIs(config[key], False)

    def test_native_and_python_diagnostics_cannot_pollute_protocol(self):
        script = r"""
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class Engine:
    def predict(self, image):
        print('secret recognition text')
        os.write(1, b'secret native stdout\n')
        os.write(2, b'secret native stderr\n')
        yield {'rec_texts': [], 'rec_scores': [], 'rec_polys': []}
def create_engine():
    print('secret model import')
    return Engine()
worker.create_engine = create_engine
sys.argv = [sys.argv[1]]
raise SystemExit(worker.main())
"""
        result = subprocess.run([sys.executable, '-c', script, str(WORKER_PATH)],
                                input=(json.dumps({'id': 'safe', 'imageBase64': image_base64()}) + '\n').encode(),
                                capture_output=True, check=True)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(json.loads(result.stdout)['id'], 'safe')
        self.assertNotIn(b'secret', result.stdout)

    def test_engine_exception_does_not_expose_content(self):
        engine = FakeEngine()
        engine.predict = lambda _: (_ for _ in ()).throw(RuntimeError('secret image text'))
        results, _, _ = self.run_requests([{'id': 'failure', 'imageBase64': image_base64()}], engine)
        self.assertEqual(results, [{'id': 'failure', 'error': 'OCR request failed'}])


if __name__ == '__main__':
    unittest.main()
