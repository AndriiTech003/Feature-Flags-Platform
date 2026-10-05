#!/bin/sh
set -e
cat > /usr/share/nginx/html/config.js <<CONFIG
window.__FFP_CONFIG__ = { apiUrl: "${API_URL:-http://localhost:4200}" };
CONFIG
