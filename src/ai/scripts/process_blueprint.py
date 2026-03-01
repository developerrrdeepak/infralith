import sys
import os
import site

# High-Integrity Path Discovery: Ensure user-installed packages (OpenCV) are visible on Azure/Cloud environments
sys.path.append(site.getusersitepackages())
# Potential Azure path fallback
sys.path.append(os.path.join(os.path.expanduser('~'), '.local/lib/python3.11/site-packages'))

import cv2
import numpy as np
import base64
import json

MAX_POLYGONS = 220
MAX_SEGMENTS = 320


def _dedupe_segments(segments, quant=4):
    seen = set()
    deduped = []
    for seg in segments:
        x1, y1, x2, y2, length = seg
        p1 = (int(round(x1 / quant) * quant), int(round(y1 / quant) * quant))
        p2 = (int(round(x2 / quant) * quant), int(round(y2 / quant) * quant))
        key = tuple(sorted((p1, p2)))
        if key in seen:
            continue
        seen.add(key)
        deduped.append([int(x1), int(y1), int(x2), int(y2), float(length)])
    return deduped

def process_blueprint(base64_string):
    # Decode base64
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]
    
    img_data = base64.b64decode(base64_string)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        return {"error": "Could not decode image"}

    h, w = img.shape[:2]

    # 1) Pre-processing (robust blueprint binarization)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    # Hybrid thresholding handles faded scans + crisp CAD exports better than fixed threshold.
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    adaptive = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 7
    )
    thresh = cv2.bitwise_or(otsu, adaptive)
    thresh = cv2.medianBlur(thresh, 3)

    # 2) Morphological cleanup for wall continuity.
    close_kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, close_kernel, iterations=2)

    # Boost long horizontal/vertical wall strokes.
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 60), 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, h // 60)))
    horizontal = cv2.morphologyEx(closed, cv2.MORPH_OPEN, h_kernel)
    vertical = cv2.morphologyEx(closed, cv2.MORPH_OPEN, v_kernel)
    walls_isolated = cv2.bitwise_or(closed, cv2.bitwise_or(horizontal, vertical))
    walls_isolated = cv2.dilate(walls_isolated, np.ones((2, 2), np.uint8), iterations=1)

    # 3) Contour vectorization (use RETR_TREE to keep interior walls/components too).
    contours, _ = cv2.findContours(walls_isolated, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    vectors = []
    min_area = max(24, int(0.00003 * w * h))
    max_area = int(0.95 * w * h)

    debug_img = np.zeros_like(img) + 255

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        perimeter = cv2.arcLength(cnt, True)
        if perimeter < 20:
            continue

        # Douglas-Peucker simplification with tighter epsilon for architectural edges.
        epsilon = 0.005 * perimeter
        approx = cv2.approxPolyDP(cnt, epsilon, True)

        if len(approx) >= 2:
            points = approx.reshape(-1, 2).astype(int).tolist()
            vectors.append(points)

            pts = approx.reshape((-1, 1, 2))
            cv2.polylines(debug_img, [pts], True, (0, 0, 255), 2)

    # Keep largest polygons first to reduce noise and prompt bloat.
    vectors = sorted(vectors, key=lambda poly: abs(cv2.contourArea(np.array(poly, dtype=np.int32))), reverse=True)
    vectors = vectors[:MAX_POLYGONS]

    # 4) Extract straight wall segments.
    min_line_len = max(12, int(min(w, h) * 0.03))
    raw_segments = []
    lines_p = cv2.HoughLinesP(
        walls_isolated,
        1,
        np.pi / 180,
        threshold=60,
        minLineLength=min_line_len,
        maxLineGap=8
    )

    if lines_p is not None:
        for line in lines_p:
            x1, y1, x2, y2 = line[0]
            length = float(np.hypot(x2 - x1, y2 - y1))
            if length < min_line_len:
                continue
            raw_segments.append([int(x1), int(y1), int(x2), int(y2), round(length, 2)])

    raw_segments.sort(key=lambda s: s[4], reverse=True)
    segments = _dedupe_segments(raw_segments)
    segments = segments[:MAX_SEGMENTS]

    for seg in segments:
        x1, y1, x2, y2, _ = seg
        cv2.line(debug_img, (x1, y1), (x2, y2), (255, 120, 0), 1)

    # Encode debug image to base64
    _, buffer = cv2.imencode('.png', debug_img)
    debug_base64 = base64.b64encode(buffer).decode('utf-8')
    
    return {
        "width": w,
        "height": h,
        "lines": vectors,
        "line_count": len(vectors),
        "segments": segments,
        "segment_count": len(segments),
        "threshold_mode": "hybrid-otsu-adaptive",
        "debug_image": f"data:image/png;base64,{debug_base64}"
    }

if __name__ == "__main__":
    try:
        # Read from stdin for large base64 strings
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input data"}))
            sys.exit(1)
            
        result = process_blueprint(input_data)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
