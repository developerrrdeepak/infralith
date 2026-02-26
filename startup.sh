#!/bin/sh

# Infralith Cloud Initialization Segment
# Fortifying the Linux environment with essential architectural dependencies

echo "Infralith Deployment: Initializing system-level dependencies..."

# Install system dependencies if root access is available (Azure App Service containers)
# Primarily for OpenCV GL and Glib bindings
apt-get update && apt-get install -y libgl1-mesa-glx libglib2.0-0 || echo "System-level apt failed, proceeding with headless fallback."

# Ensure headless OpenCV is available in the user space
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt --user --no-cache-dir

echo "Infralith Deployment: Dependencies fortified. Starting Node.js engine..."

# Start the application
npm start
