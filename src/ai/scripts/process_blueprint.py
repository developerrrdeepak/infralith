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
import io

def process_blueprint(base64_string):
    # Decode base64
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]
    
    img_data = base64.b64decode(base64_string)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None:
        return {"error": "Could not decode image"}

    # 1. Pre-processing (High Precision Architectural Segmentation)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Binarization: Invert so walls are white on black
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    
    # Morphology: Bridge small gaps and remove thin noise (text/furniture)
    kernel = np.ones((5,5), np.uint8)
    # Morphological closing to join broken wall segments
    walls_isolated = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    
    # 2. Vectorization: findContours & approxPolyDP
    contours, _ = cv2.findContours(walls_isolated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    vectors = []
    # Create a white canvas to draw detected lines for debugging
    debug_img = np.zeros_like(img) + 255
    
    for cnt in contours:
        # Douglas-Peucker algorithm for geometric simplification
        epsilon = 0.01 * cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon, True)
        
        if len(approx) >= 2:
            points = approx.reshape(-1, 2).tolist()
            vectors.append(points)
            
            # Draw on debug image
            pts = approx.reshape((-1, 1, 2))
            cv2.polylines(debug_img, [pts], True, (0, 0, 255), 2)

    # Encode debug image to base64
    _, buffer = cv2.imencode('.png', debug_img)
    debug_base64 = base64.b64encode(buffer).decode('utf-8')

    h, w = img.shape[:2]
    
    return {
        "width": w,
        "height": h,
        "lines": vectors, # Now returns structural polygons
        "line_count": len(vectors),
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
