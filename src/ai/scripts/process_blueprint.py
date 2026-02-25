import cv2
import numpy as np
import base64
import json
import sys
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

    # 1. Pre-processing
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Adaptive Thresholding for uneven lighting scans
    thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2)
    
    # Morphological closing to join broken lines
    kernel = np.ones((3,3), np.uint8)
    closing = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    
    # Canny Edge Detection
    edges = cv2.Canny(closing, 50, 150, apertureSize=3)
    
    # 2. Line Detection (Hough Line Transform)
    # Increased sensitivity for thin lines
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=40, minLineLength=30, maxLineGap=15)
    
    # Create a white canvas to draw detected lines for debugging
    debug_img = np.zeros_like(img) + 255
    extracted_lines = []
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            # Draw on debug image
            cv2.line(debug_img, (x1, y1), (x2, y2), (255, 0, 0), 2)
            
            extracted_lines.append({
                "start": [int(x1), int(y1)],
                "end": [int(x2), int(y2)],
                "length": float(np.sqrt((x2-x1)**2 + (y2-y1)**2))
            })

    # Encode debug image to base64
    _, buffer = cv2.imencode('.png', debug_img)
    debug_base64 = base64.b64encode(buffer).decode('utf-8')

    # 3. Simple scaling estimation (placeholder)
    h, w = img.shape[:2]
    
    return {
        "width": w,
        "height": h,
        "lines": extracted_lines,
        "line_count": len(extracted_lines),
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
