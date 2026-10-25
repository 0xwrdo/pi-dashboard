#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -c "import ast; ast.parse(open('pi.py').read())"
sudo install -d -m 755 /pi/static
sudo install -m 644 pi.py /pi/pi.py
sudo install -m 644 static/* /pi/static/
sudo systemctl restart pi
sleep 2
systemctl is-active pi
