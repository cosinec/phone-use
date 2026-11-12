#!/usr/bin/env python3
"""Persistent, single-image PaddleOCR JSONL worker owned by the Rust gateway."""
import base64
import io
import json
import math
import numbers
import os
import sys

MAX_INPUT_LINE_BYTES = 24 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
MAX_DIMENSION = 8192
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_LINES = 512
MAX_TEXT_CHARS = 2048
ERROR_MESSAGE = 'OCR request failed'


def create_engine():
    # Set these before importing PaddleX/Paddle. Model paths remain local once
    # --prepare has populated the user's PaddleX cache during image construction.
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    os.environ.setdefault('OMP_NUM_THREADS', '2')
    os.environ.setdefault('GLOG_minloglevel', '3')
    from paddleocr import PaddleOCR

    return PaddleOCR(
        device='cpu',
        text_detection_model_name='PP-OCRv5_mobile_det',
        text_recognition_model_name='PP-OCRv5_mobile_rec',
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_type='max',
        text_det_limit_side_len=1280,
        text_recognition_batch_size=8,
        cpu_threads=2,
    )


def decode_image(encoded):
    import numpy as np
    from PIL import Image

    if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError('image size')
    data = base64.b64decode(encoded, validate=True)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError('image size')
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    with Image.open(io.BytesIO(data)) as image:
        width, height = image.size
        if (image.format not in ('JPEG', 'PNG') or getattr(image, 'n_frames', 1) != 1
                or width <= 0 or height <= 0 or max(width, height) > MAX_DIMENSION
                or width * height > MAX_IMAGE_PIXELS):
            raise ValueError('image dimensions')
        # PaddleX accepts OpenCV BGR arrays. Avoid EXIF transpose and document
        # transformations so returned polygons address the exact input raster.
        pixels = np.asarray(image.convert('RGB'))[:, :, ::-1].copy()
    return pixels, width, height


def numeric(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise ValueError('invalid number')
    value = float(value)
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise ValueError('invalid number')
    return value


def encode_response(response):
    return json.dumps(response, ensure_ascii=False, allow_nan=False,
                      separators=(',', ':')).encode('utf-8') + b'\n'


def recognition_response(request_id, result, width, height):
    texts = result['rec_texts']
    scores = result['rec_scores']
    polygons = result['rec_polys']
    if len(texts) != len(scores) or len(texts) != len(polygons):
        raise ValueError('invalid recognition arrays')
    lines = []
    truncated = False
    for text, score, polygon in zip(texts, scores, polygons):
        if not isinstance(text, str) or len(polygon) != 4:
            raise ValueError('invalid recognition line')
        points = []
        for point in polygon:
            if len(point) != 2:
                raise ValueError('invalid polygon point')
            points.append([numeric(point[0], 0, width), numeric(point[1], 0, height)])
        confidence = numeric(score, 0, 1)
        if not text.strip():
            continue
        truncated = truncated or len(text) > MAX_TEXT_CHARS
        lines.append({'text': text[:MAX_TEXT_CHARS], 'confidence': confidence, 'polygon': points})
    # Stable top-to-bottom, left-to-right ordering is independent of model yield
    # order. Coordinates preserve the input raster, including cropped captures.
    lines.sort(key=lambda line: (min(point[1] for point in line['polygon']),
                                 min(point[0] for point in line['polygon'])))
    response = {'id': request_id, 'width': width, 'height': height, 'lines': [], 'truncated': False}
    byte_count = len(encode_response(response))
    for line in lines:
        line_bytes = len(encode_response(line)) - 1
        if (len(response['lines']) >= MAX_LINES
                or byte_count + line_bytes + bool(response['lines']) > MAX_OUTPUT_BYTES):
            truncated = True
            break
        byte_count += line_bytes + bool(response['lines'])
        response['lines'].append(line)
    response['truncated'] = truncated
    return response


def serve(source, output, engine_factory=create_engine):
    engine = None
    while True:
        line = source.readline(MAX_INPUT_LINE_BYTES + 1)
        if not line:
            return
        request_id = ''
        try:
            if len(line) > MAX_INPUT_LINE_BYTES:
                # Drain this message without retaining it or interpreting fragments
                # as new requests. The Rust supervisor also bounds writes.
                while line and not line.endswith(b'\n'):
                    line = source.readline(MAX_INPUT_LINE_BYTES + 1)
                raise ValueError('input size')
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('invalid request')
            identifier = request.get('id')
            if not isinstance(identifier, str) or not 1 <= len(identifier) <= 128:
                raise ValueError('invalid id')
            identifier.encode('utf-8')
            request_id = identifier
            pixels, width, height = decode_image(request.get('imageBase64'))
            if engine is None:
                engine = engine_factory()
            predictions = iter(engine.predict(pixels))
            result = next(predictions)
            if next(predictions, None) is not None:
                raise ValueError('multiple images')
            response = recognition_response(request_id, result, width, height)
        except Exception:
            # Dependency exceptions may contain image bytes or recognized text.
            # Only this fixed message leaves the worker on a failed request.
            response = {'id': request_id, 'error': ERROR_MESSAGE}
        output.write(encode_response(response))
        output.flush()


def main():
    # Paddle imports and native libraries can print directly to file descriptors.
    # Keep a dedicated protocol descriptor and silence both inherited descriptors
    # for the entire child lifetime, including model import and shutdown hooks.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0)
    with open(os.devnull, 'w') as sink:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(sink.fileno(), sys.stdout.fileno())
        os.dup2(sink.fileno(), sys.stderr.fileno())
    if sys.argv[1:] == ['--prepare']:
        try:
            create_engine()
        except Exception:
            return 1
        return 0
    if sys.argv[1:]:
        return 1
    serve(sys.stdin.buffer, protocol, create_engine)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
