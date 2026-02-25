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
    
    # Noise Removal
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Canny Edge Detection
    edges = cv2.Canny(blurred, 50, 150, apertureSize=3)
    
    # 2. Line Detection (Hough Line Transform)
    # rho, theta, threshold, minLineLength, maxLineGap
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=50, minLineLength=50, maxLineGap=10)
    
    extracted_lines = []
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            extracted_lines.append({
                "start": [int(x1), int(y1)],
                "end": [int(x2), int(y2)],
                "length": float(np.sqrt((x2-x1)**2 + (y2-y1)**2))
            })

    # 3. Simple scaling estimation (placeholder)
    # Realistic logic would involve OCR or looking for scale bars
    # For now, we return the lines and image dimensions
    h, w = img.shape[:2]
    
    return {
        "width": w,
        "height": h,
        "lines": extracted_lines,
        "line_count": len(extracted_lines)
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
